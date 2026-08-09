/**
 * /api/sync — 공부 기록 동기화 + 조회
 * ------------------------------------------------------------------
 * POST /api/sync
 *   어플 로컬 기록(study_records)을 노션 '공부 타이머 기록' DB에 동기화한다.
 *   요청 본문:
 *   {
 *     "records": [
 *       { "date": "2026-08-09", "subject": "일본어", "minutes": 45, "source": "타이머", "memo": "N5 단어 20개" }
 *     ]
 *   }
 *   중복 판단 기준: 날짜 + 과목 + 소스 + 시간(분) 조합이 이미 존재하면 skip.
 *   (study-app이 초단위 저장으로 같은 날짜/과목/소스의 기록이 여러 개 생길 수 있어
 *   minutes를 키에 포함 — 시간이 다르면 다른 레코드로 인식해 전부 저장한다)
 *   응답: { "success": true, "created": N, "skipped": N, "errors": [...] }
 *
 * GET /api/sync
 *   노션 '공부 타이머 기록' DB 전체 기록을 반환한다 (타이머앱 Pull용).
 *   CORS 허용, 인증 없음 (개인용).
 *   응답: { "success": true, "records": [{ "id", "date", "subject", "minutes", "source", "memo" }] }
 */
const {
  queryStudyRecords,
  createStudyRecord,
  studyRecordKey,
} = require('../lib/notion');

const ALLOWED_SUBJECTS = new Set(['일본어', '한자', '단어장']);
const ALLOWED_SOURCES = new Set(['타이머', '공부어플']);

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { /* fallthrough */ }
  }
  if (req.body && typeof req.body === 'object') {
    try {
      const parsed = JSON.parse(req.body.toString('utf8'));
      return parsed;
    } catch (_) { /* fallthrough */ }
  }
  return {};
}

function normalizeRecord(r) {
  return {
    date: String(r.date || '').trim(),
    subject: String(r.subject || '').trim(),
    minutes: Math.max(0, Math.round(Number(r.minutes) || 0)),
    source: String(r.source || '').trim(),
    memo: r.memo != null ? String(r.memo) : null,
  };
}

function validateRecord(r) {
  if (!r.date) return '날짜가 비어 있습니다';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return `날짜 형식이 올바르지 않습니다: ${r.date}`;
  if (!r.subject) return '과목이 비어 있습니다';
  if (!ALLOWED_SUBJECTS.has(r.subject)) return `지원하지 않는 과목입니다: ${r.subject}`;
  if (r.minutes <= 0) return '시간(분)은 1 이상이어야 합니다';
  if (!r.source) return '소스가 비어 있습니다';
  if (!ALLOWED_SOURCES.has(r.source)) return `지원하지 않는 소스입니다: ${r.source}`;
  return null;
}

module.exports = async function handler(req, res) {
  // CORS (어플/대시보드에서 직접 호출 가능하도록)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  // GET /api/sync — 노션 전체 기록 조회 (타이머앱 Pull, 인증 없음)
  if (req.method === 'GET') {
    try {
      const records = (await queryStudyRecords()).map((r) => ({
        id: r.id,
        date: r.date,
        subject: r.subject,
        minutes: r.minutes,
        source: r.source,
        memo: r.memo,
      }));
      return res.json({ success: true, records });
    } catch (err) {
      console.error('[sync] GET 조회 실패:', err.message);
      return res.status(500).json({ success: false, records: [], error: `노션 조회 실패: ${err.message}` });
    }
  }

  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'GET 또는 POST 메서드만 허용됩니다.' });
    return;
  }

  const body = parseBody(req);
  const rawRecords = Array.isArray(body.records) ? body.records : [];
  if (rawRecords.length === 0) {
    res.status(400).json({ success: false, error: 'records 배열이 필요합니다.' });
    return;
  }

  // 검증 + 정규화
  const records = [];
  const errors = [];
  rawRecords.forEach((r, i) => {
    const norm = normalizeRecord(r);
    const problem = validateRecord(norm);
    if (problem) errors.push({ index: i, date: norm.date, subject: norm.subject, source: norm.source, message: problem });
    else records.push(norm);
  });

  if (records.length === 0) {
    return res.status(400).json({ success: false, created: 0, skipped: 0, errors });
  }

  // 기존 기록을 전부 조회해 중복 키를 만든다
  let existingKeys;
  try {
    const existing = await queryStudyRecords();
    existingKeys = new Set(existing.map(studyRecordKey));
  } catch (err) {
    console.error('[sync] 노션 조회 실패:', err.message);
    return res.status(500).json({ success: false, created: 0, skipped: 0, errors: [{ message: `노션 조회 실패: ${err.message}` }] });
  }

  let created = 0;
  let skipped = 0;
  for (const record of records) {
    const key = studyRecordKey(record);
    if (existingKeys.has(key)) {
      skipped += 1;
      continue;
    }
    try {
      await createStudyRecord(record);
      existingKeys.add(key);
      created += 1;
    } catch (err) {
      console.error('[sync] 생성 실패:', record, err.message);
      errors.push({
        index: null,
        date: record.date,
        subject: record.subject,
        source: record.source,
        message: err.message,
      });
    }
  }

  return res.json({ success: true, created, skipped, errors });
};
