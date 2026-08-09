/**
 * 노션 API 공통 헬퍼
 * ------------------------------------------------------------------
 * - 노션 API 키는 어플에 절대 노출하지 않는다 (서버리스에서만 사용).
 * - 노션 API 버전: 2025-09-03
 *
 * 최신 노션 구조(2025-09-03)에서는 database의 properties가 null이고
 * data_source가 실제 속성을 가질 수 있다. 따라서:
 *   1) NOTION_DATA_SOURCE_ID 가 설정되어 있으면 우선 data source 엔드포인트로 조회/생성
 *   2) 실패하면 기존 database_id(parent) 방식으로 폴백
 * 의 이중 경로를 사용한다. @notionhq/client 는 database_id 경로에서 사용한다.
 */
const { Client } = require('@notionhq/client');

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;            // 공부 타이머 기록 DB
const NOTION_VOCAB_DATABASE_ID = process.env.NOTION_VOCAB_DATABASE_ID;   // 단어장 DB
const NOTION_DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID;         // (선택) 공부 기록 data source
const NOTION_VOCAB_DATA_SOURCE_ID =
  process.env.NOTION_VOCAB_DATA_SOURCE_ID || NOTION_VOCAB_DATABASE_ID;   // (선택) 단어장 data source (기본: 단어장 DB ID)
const NOTION_API_VERSION = '2025-09-03';
const NOTION_BASE_URL = 'https://api.notion.com/v1';

function requireEnv() {
  if (!NOTION_API_KEY) throw new Error('NOTION_API_KEY 환경변수가 설정되지 않았습니다.');
}

function getClient() {
  requireEnv();
  return new Client({ auth: NOTION_API_KEY, notionVersion: NOTION_API_VERSION });
}

async function notionFetch(path, body) {
  const resp = await fetch(`${NOTION_BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 응답이 JSON이 아닐 수 있음 */ }
  if (!resp.ok) {
    const err = new Error(`노션 API 오류 (${resp.status}): ${text.slice(0, 400)}`);
    err.status = resp.status;
    err.json = json;
    throw err;
  }
  return json;
}

/**
 * DB의 모든 페이지를 조회한다 (100개 단위 페이지네이션).
 * @param {string} databaseId  공부 기록 DB 또는 단어장 DB ID
 * @param {string} [dataSourceId] 최신 구조의 data source ID (있으면 우선 사용)
 */
async function queryAllPages(databaseId, dataSourceId) {
  requireEnv();
  const candidatePaths = [];
  if (dataSourceId) candidatePaths.push(`/data_sources/${dataSourceId}/query`);
  candidatePaths.push(`/databases/${databaseId}/query`);

  const results = [];
  let cursor = undefined;
  let lastError = null;

  // 어떤 엔드포인트가 동작하는지 결정한다 (엔드포인트당 1회 시도 후 커서로 계속)
  let pathIndex = 0;
  let hasMore = true;
  while (hasMore) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    try {
      const json = await notionFetch(candidatePaths[pathIndex], body);
      lastError = null;
      results.push(...(json.results || []));
      hasMore = json.has_more || false;
      cursor = json.next_cursor || undefined;
    } catch (err) {
      if (pathIndex < candidatePaths.length - 1) {
        // 이 경로가 안 되면 다음 엔드포인트로 전환 (첫 페이지 실패 시에만)
        if (results.length === 0) {
          pathIndex += 1;
          lastError = err;
          hasMore = true;
          continue;
        }
        throw err;
      }
      throw err;
    }
  }
  if (lastError && results.length === 0) throw lastError;
  return results;
}

/** 속성 값 추출 (title / rich_text / select / number / date 공통 파서) */
function propText(prop) {
  if (!prop) return '';
  if (prop.type === 'title' || prop.type === 'rich_text') {
    const arr = prop[prop.type] || [];
    return arr.map((t) => t.plain_text || '').join('');
  }
  if (prop.type === 'select') return prop.select ? prop.select.name : '';
  if (prop.type === 'multi_select') {
    return (prop.multi_select || []).map((s) => s.name).join(', ');
  }
  if (prop.type === 'number') return prop.number;
  if (prop.type === 'date') return prop.date ? prop.date.start : '';
  return '';
}

/** 공부 기록 페이지 → 일반 객체 */
function formatStudyRecord(page) {
  const p = page.properties || {};
  return {
    id: page.id,
    name: propText(p.Name || p['이름']),
    date: propText(p['날짜']),
    subject: propText(p['과목']),
    minutes: Number(propText(p['시간(분)'])) || 0,
    source: propText(p['소스']),
    memo: propText(p['메모']),
  };
}

/**
 * 중복 판단용 키: 날짜 + 과목 + 소스 + 시간(분).
 * study-app이 초단위로 저장하면서 같은 날짜/과목/소스의 기록이 여러 레코드로 생길 수 있다.
 * (예: 7분 33초를 (2분, 1분, 4분 33초) 세션으로 나누면 각각 로컬 DB에 저장)
 * 시간(minutes)을 키에 포함해 같은 날짜/과목/소스라도 시간이 다르면 서로 다른
 * 레코드로 인식되어 전부 노션에 저장된다.
 */
function studyRecordKey(r) {
  return [String(r.date || ''), String(r.subject || ''), String(r.source || ''), String(r.minutes || '')].join('|');
}

/** 단어장 페이지 → 일반 객체 */
function formatWord(page) {
  const p = page.properties || {};
  const srsLevel = propText(p['SRS 레벨']);
  const reviewCount = propText(p['회독']);
  return {
    id: page.id,
    word: propText(p.Name || p['단어']),
    meaning: propText(p['뜻']),
    example: propText(p['예문']),
    category: propText(p['카테고리']),
    srsLevel: srsLevel === '' ? 1 : Number(srsLevel) || 1,
    reviewCount: reviewCount === '' ? 0 : Number(reviewCount) || 0,
  };
}

/** 단어 중복 판단 키: 단어 + 카테고리 */
function wordKey(w) {
  return [String(w.word || ''), String(w.category || '')].join('|');
}

/**
 * 페이지 생성. 우선 database_id(parent)로 시도하고,
 * data source ID가 설정된 경우 실패 시 data_source parent로 재시도한다.
 */
async function createPage(properties, { databaseId, dataSourceId } = {}) {
  requireEnv();
  const candidates = [{ parent: { database_id: databaseId }, properties }];
  if (dataSourceId) {
    candidates.push({ parent: { type: 'data_source', data_source_id: dataSourceId }, properties });
  }

  let lastError = null;
  for (const payload of candidates) {
    try {
      const json = await notionFetch('/pages', payload);
      return json;
    } catch (err) {
      lastError = err;
      // 잘못된 parent 구조(400/404)일 때만 다음 후보로 전환
      if (err.status !== 400 && err.status !== 404) throw err;
    }
  }
  throw lastError;
}

/** 공부 기록 → 노션 페이지 생성 */
async function createStudyRecord(record) {
  const properties = {
    Name: { title: [{ text: { content: `${record.date} ${record.subject}` } }] },
    '날짜': { date: { start: record.date } },
    '과목': { select: { name: record.subject } },
    '시간(분)': { number: Number(record.minutes) || 0 },
    '소스': { select: { name: record.source } },
  };
  if (record.memo) {
    properties['메모'] = { rich_text: [{ text: { content: String(record.memo).slice(0, 2000) } }] };
  }
  return createPage(properties, {
    databaseId: NOTION_DATABASE_ID,
    dataSourceId: NOTION_DATA_SOURCE_ID,
  });
}

/** 단어 → 노션 단어장 페이지 생성 */
async function createWord(word) {
  const properties = {
    Name: { title: [{ text: { content: word.word } }] },
    '뜻': { rich_text: [{ text: { content: word.meaning || '' } }] },
    '카테고리': { select: { name: word.category || '일본어' } },
  };
  if (word.example) properties['예문'] = { rich_text: [{ text: { content: String(word.example) } }] };
  if (word.srsLevel != null) properties['SRS 레벨'] = { number: Number(word.srsLevel) || 1 };
  if (word.reviewCount != null) properties['회독'] = { number: Number(word.reviewCount) || 0 };
  return createPage(properties, {
    databaseId: NOTION_VOCAB_DATABASE_ID,
    dataSourceId: NOTION_VOCAB_DATA_SOURCE_ID,
  });
}

/** 전체 공부 기록 조회 */
async function queryStudyRecords() {
  const pages = await queryAllPages(NOTION_DATABASE_ID, NOTION_DATA_SOURCE_ID);
  return pages.map(formatStudyRecord).filter((r) => r.date);
}

/** 전체 단어 조회 */
async function queryWords() {
  const pages = await queryAllPages(NOTION_VOCAB_DATABASE_ID, NOTION_VOCAB_DATA_SOURCE_ID);
  return pages.map(formatWord).filter((w) => w.word);
}

module.exports = {
  NOTION_API_KEY,
  NOTION_DATABASE_ID,
  NOTION_VOCAB_DATABASE_ID,
  NOTION_DATA_SOURCE_ID,
  NOTION_VOCAB_DATA_SOURCE_ID,
  NOTION_API_VERSION,
  getClient,
  queryAllPages,
  queryStudyRecords,
  queryWords,
  createStudyRecord,
  createWord,
  formatStudyRecord,
  formatWord,
  studyRecordKey,
  wordKey,
};
