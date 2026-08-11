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

async function notionFetch(path, body, method = 'POST') {
  const resp = await fetch(`${NOTION_BASE_URL}${path}`, {
    method,
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

/** 초기 FSRS 컴포넌트 상태 (무학습) */
const DEFAULT_FSRS_COMPONENT = () => ({ stability: 0, difficulty: 5, due: 0, lastReview: 0, reps: 0, lapses: 0 });

/** FSRS 3중 기본값 */
const DEFAULT_SRS = () => ({
  meaning: DEFAULT_FSRS_COMPONENT(),
  onyomi: DEFAULT_FSRS_COMPONENT(),
  kunyomi: DEFAULT_FSRS_COMPONENT(),
});

/**
 * 'SRS' 속성(rich_text)을 파싱해 srs 오브젝트 반환.
 * @param {string} raw  JSON 문자열
 * @param {string} category  카테고리 (한자/일본어/가나)
 * @returns {{ meaning, onyomi, kunyomi }}
 */
function parseSrs(raw, category) {
  if (!raw) return DEFAULT_SRS();
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return DEFAULT_SRS(); }
  if (!parsed || typeof parsed !== 'object') return DEFAULT_SRS();

  // m=meaning, o=onyomi, k=kunyomi 로 축약된 키 지원
  const expand = (key, altKey) => {
    const src = parsed[key] || parsed[altKey];
    if (!src || typeof src !== 'object') return DEFAULT_FSRS_COMPONENT();
    return {
      stability: typeof src.s === 'number' ? src.s : 0,
      difficulty: typeof src.d === 'number' ? src.d : 5,
      due: typeof src.due === 'number' ? src.due : 0,
      lastReview: typeof src.lr === 'number' ? src.lr : (typeof src.lastReview === 'number' ? src.lastReview : 0),
      reps: typeof src.r === 'number' ? src.r : (typeof src.reps === 'number' ? src.reps : 0),
      lapses: typeof src.l === 'number' ? src.l : (typeof src.lapses === 'number' ? src.lapses : 0),
    };
  };

  const srs = {
    meaning: expand('meaning', 'm'),
    onyomi: expand('onyomi', 'o'),
    kunyomi: expand('kunyomi', 'k'),
  };

  // 가나 카테고리는 meaning만 유효
  if (category === '히라가나' || category === '카타가나') {
    srs.onyomi = DEFAULT_FSRS_COMPONENT();
    srs.kunyomi = DEFAULT_FSRS_COMPONENT();
  }

  return srs;
}

/**
 * SRS 오브젝트 → 축약 JSON 문자열 (rich_text 저장용).
 * 한자: m/o/k 전부, 일본어: m + 데이터 있는 o/k, 가나: m만
 */
function serializeSrs(srs, category) {
  if (!srs) return null;
  const shouldInclude = (comp) => comp && (comp.reps > 0 || comp.stability > 0 || comp.due > 0);
  const obj = {};
  obj.m = { s: srs.meaning.stability, d: srs.meaning.difficulty, due: srs.meaning.due, lr: srs.meaning.lastReview, r: srs.meaning.reps, l: srs.meaning.lapses };
  if (category === '한자' || (category === '일본어' && shouldInclude(srs.onyomi))) {
    obj.o = { s: srs.onyomi.stability, d: srs.onyomi.difficulty, due: srs.onyomi.due, lr: srs.onyomi.lastReview, r: srs.onyomi.reps, l: srs.onyomi.lapses };
  }
  if (category === '한자' || (category === '일본어' && shouldInclude(srs.kunyomi))) {
    obj.k = { s: srs.kunyomi.stability, d: srs.kunyomi.difficulty, due: srs.kunyomi.due, lr: srs.kunyomi.lastReview, r: srs.kunyomi.reps, l: srs.kunyomi.lapses };
  }
  return JSON.stringify(obj);
}

/** 단어장 페이지 → 일반 객체 */
function formatWord(page) {
  const p = page.properties || {};
  const srsLevel = propText(p['SRS 레벨']);
  const reviewCount = propText(p['회독']);
  const level = propText(p['레벨']);
  const hiragana = propText(p['히라가나']);
  const detail = propText(p['상세']);
  const onyomi = propText(p['음독']);
  const kunyomi = propText(p['훈독']);
  const category = propText(p['카테고리']);
  const srsRaw = propText(p['SRS']);
  const srs = parseSrs(srsRaw, category);
  return {
    id: page.id,
    word: propText(p.Name || p['단어']),
    meaning: propText(p['뜻']),
    example: propText(p['예문']),
    category: category,
    level: level === '' ? null : level, // 한자 N5~N1 (select) — 없으면 null
    hiragana: hiragana === '' ? null : hiragana, // 일본어 단어의 읽는 법 (히라가나) — 없으면 null
    detail: detail === '' ? null : detail, // 상세 설명 (한자 어원/조합 등) — 없으면 null
    onyomi: onyomi === '' ? null : onyomi, // 한자 음독 (일본어 + 한국어 발음 병기) — 없으면 null
    kunyomi: kunyomi === '' ? null : kunyomi, // 한자 훈독 (일본어 + 한국어 발음 병기) — 없으면 null
    srsLevel: srsLevel === '' ? 1 : Number(srsLevel) || 1,
    reviewCount: reviewCount === '' ? 0 : Number(reviewCount) || 0,
    // ★ SRS FSRS 상태 (JSON parse 결과)
    srs: {
      meaning: srs.meaning,
      onyomi: srs.onyomi.stability === 0 && srs.onyomi.difficulty === 5 ? null : srs.onyomi,
      kunyomi: srs.kunyomi.stability === 0 && srs.kunyomi.difficulty === 5 ? null : srs.kunyomi,
    },
    // 노션 페이지 수정 시각 (epoch ms) — 앱 updatedAt과 비교해 충돌 해결(최신 수정 우선)
    updatedAt: Date.parse(page.last_edited_time || '') || 0,
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
  if (word.level) properties['레벨'] = { select: { name: String(word.level) } }; // 한자 N5~N1
  if (word.hiragana) properties['히라가나'] = { rich_text: [{ text: { content: String(word.hiragana) } }] }; // 일본어 단어의 읽는 법
  if (word.detail) properties['상세'] = { rich_text: [{ text: { content: String(word.detail) } }] }; // 상세 설명 (한자 어원/조합 등)
  if (word.onyomi) properties['음독'] = { rich_text: [{ text: { content: String(word.onyomi) } }] }; // 한자 음독
  if (word.kunyomi) properties['훈독'] = { rich_text: [{ text: { content: String(word.kunyomi) } }] }; // 한자 훈독
  if (word.srsLevel != null) properties['SRS 레벨'] = { number: Number(word.srsLevel) || 1 };
  if (word.reviewCount != null) properties['회독'] = { number: Number(word.reviewCount) || 0 };
  // ★ SRS FSRS 상태 저장
  const srsJson = word.srs ? serializeSrs(word.srs, word.category) : null;
  if (srsJson) properties['SRS'] = { rich_text: [{ text: { content: srsJson } }] };
  return createPage(properties, {
    databaseId: NOTION_VOCAB_DATABASE_ID,
    dataSourceId: NOTION_VOCAB_DATA_SOURCE_ID,
  });
}

/**
 * 단어 페이지 내용 갱신 (PATCH /pages/{id}).
 * 충돌 해결 시 앱 updatedAt이 노션 last_edited_time보다 최신일 때만 호출된다.
 * SRS 레벨/회독 속성은 건드리지 않는다 (암기 상태 보존).
 */
async function updateWord(pageId, word) {
  requireEnv();
  const properties = {
    Name: { title: [{ text: { content: word.word } }] },
    '뜻': { rich_text: [{ text: { content: word.meaning || '' } }] },
    '카테고리': { select: { name: word.category || '일본어' } },
  };
  if (word.example) properties['예문'] = { rich_text: [{ text: { content: String(word.example) } }] };
  if (word.level) properties['레벨'] = { select: { name: String(word.level) } }; // 한자 N5~N1
  if (word.hiragana) properties['히라가나'] = { rich_text: [{ text: { content: String(word.hiragana) } }] }; // 일본어 단어의 읽는 법
  if (word.detail) properties['상세'] = { rich_text: [{ text: { content: String(word.detail) } }] }; // 상세 설명 (한자 어원/조합 등)
  if (word.onyomi) properties['음독'] = { rich_text: [{ text: { content: String(word.onyomi) } }] }; // 한자 음독
  if (word.kunyomi) properties['훈독'] = { rich_text: [{ text: { content: String(word.kunyomi) } }] }; // 한자 훈독
  // ★ SRS FSRS 상태 저장
  const srsJson = word.srs ? serializeSrs(word.srs, word.category) : null;
  if (srsJson) properties['SRS'] = { rich_text: [{ text: { content: srsJson } }] };
  return notionFetch(`/pages/${pageId}`, { properties }, 'PATCH');
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

/** 초기 상태인 FSRS 컴포넌트인지 확인 (stability=0, difficulty=5, due=0, reps=0, lapses=0) */
function isDefaultFsrsComponent(comp) {
  if (!comp) return true;
  return (comp.stability === 0 || comp.stability === 0.0) && comp.difficulty === 5
    && comp.reps === 0 && comp.lapses === 0;
}

/**
 * 한자 카드의 onyomi/kunyomi SRS를 초기화한다.
 * meaning SRS는 유지된다.
 * @returns {{ total: number, reset: number, skipped: number }}
 */
async function resetKanjiSrs() {
  requireEnv();
  const pages = await queryAllPages(NOTION_VOCAB_DATABASE_ID, NOTION_VOCAB_DATA_SOURCE_ID);
  const kanjiPages = pages.filter((p) => {
    const catProp = (p.properties || {})['카테고리'];
    return propText(catProp) === '한자';
  });

  let reset = 0;
  let skipped = 0;

  for (let i = 0; i < kanjiPages.length; i++) {
    const page = kanjiPages[i];
    const rawSrs = propText((page.properties || {})['SRS']);
    const srs = parseSrs(rawSrs, '한자');

    if (isDefaultFsrsComponent(srs.onyomi) && isDefaultFsrsComponent(srs.kunyomi)) {
      skipped++;
      continue;
    }

    // onyomi/kunyomi만 초기화, meaning 유지
    srs.onyomi = DEFAULT_FSRS_COMPONENT();
    srs.kunyomi = DEFAULT_FSRS_COMPONENT();
    const srsJson = serializeSrs(srs, '한자');

    // SRS 속성만 PATCH — 다른 속성 건드리지 않음
    await notionFetch(`/pages/${page.id}`, {
      properties: {
        'SRS': { rich_text: [{ text: { content: srsJson } }] },
      },
    }, 'PATCH');

    reset++;

    // 노션 API rate limit: 초당 3회 → 500ms 간격 (10회 연속 후 1s)
    if (i < kanjiPages.length - 1 && reset % 10 === 0) {
      await new Promise((r) => setTimeout(r, 1000));
    } else if (i < kanjiPages.length - 1) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  return { total: kanjiPages.length, reset, skipped };
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
  updateWord,
  formatStudyRecord,
  formatWord,
  studyRecordKey,
  wordKey,
  resetKanjiSrs,
};
