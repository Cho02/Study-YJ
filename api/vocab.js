/**
 * /vocab — 노션 단어장 DB 양방향 동기화
 * ------------------------------------------------------------------
 * GET  /vocab : 노션 단어장 DB 전체 조회 → 앱에 단어 목록 전달
 *   응답: { "success": true, "words": [{ "id", "word", "meaning", "example", "category", "level", "srsLevel", "reviewCount" }] }
 *
 * POST /vocab : 앱에서 추가한 단어를 노션 단어장 DB에 생성
 *   요청: { "records": [{ "word", "meaning", "example", "category", "level" }] }
 *   중복 체크(단어+카테고리) 후 생성. level은 한자 N5~N1 (select), 없으면 생략.
 *   응답: { "success": true, "created": N, "skipped": N, "createdIds": [...] }
 */
const { queryWords, createWord, wordKey } = require('../lib/notion');

const ALLOWED_CATEGORIES = new Set(['일본어', '한자', '카타가나', '히라가나']);
const MAX_RECORDS = 500;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { /* fallthrough */ }
  }
  if (req.body && typeof req.body === 'object') {
    try { return JSON.parse(req.body.toString('utf8')); } catch (_) { /* fallthrough */ }
  }
  return {};
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    let words;
    try {
      words = await queryWords();
    } catch (err) {
      console.error('[vocab] 조회 실패:', err.message);
      return res.status(500).json({ success: false, error: `노션 조회 실패: ${err.message}` });
    }
    return res.json({ success: true, words });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    const rawRecords = Array.isArray(body.records) ? body.records : [];
    if (rawRecords.length === 0) {
      return res.status(400).json({ success: false, error: 'records 배열이 필요합니다.' });
    }
    if (rawRecords.length > MAX_RECORDS) {
      return res.status(400).json({ success: false, error: `한 번에 ${MAX_RECORDS}개 이하만 전송할 수 있습니다.` });
    }

    const records = [];
    const errors = [];
    rawRecords.forEach((r, i) => {
      const word = String(r.word || '').trim();
      if (!word) {
        errors.push({ index: i, message: '단어가 비어 있습니다.' });
        return;
      }
      const category = String(r.category || '일본어').trim();
      if (!ALLOWED_CATEGORIES.has(category)) {
        errors.push({ index: i, word, message: `지원하지 않는 카테고리입니다: ${category}` });
        return;
      }
      records.push({
        word,
        meaning: r.meaning != null ? String(r.meaning) : '',
        example: r.example != null ? String(r.example) : '',
        category,
        level: r.level != null ? String(r.level).trim() : null, // 한자 N5~N1
        srsLevel: r.srsLevel != null ? Number(r.srsLevel) || 1 : 1,
        reviewCount: r.reviewCount != null ? Number(r.reviewCount) || 0 : 0,
      });
    });

    if (records.length === 0) {
      return res.status(400).json({ success: false, created: 0, skipped: 0, errors });
    }

    let existingKeys;
    try {
      const existing = await queryWords();
      existingKeys = new Set(existing.map(wordKey));
    } catch (err) {
      console.error('[vocab] 중복 체크용 조회 실패:', err.message);
      return res.status(500).json({ success: false, error: `노션 조회 실패: ${err.message}` });
    }

    let created = 0;
    let skipped = 0;
    const createdIds = [];
    for (const record of records) {
      const key = wordKey(record);
      if (existingKeys.has(key)) {
        skipped += 1;
        continue;
      }
      try {
        const page = await createWord(record);
        existingKeys.add(key);
        created += 1;
        createdIds.push(page.id);
      } catch (err) {
        console.error('[vocab] 생성 실패:', record.word, err.message);
        errors.push({ word: record.word, message: err.message });
      }
    }

    return res.json({ success: true, created, skipped, createdIds, errors });
  }

  res.status(405).json({ success: false, error: 'GET 또는 POST만 허용됩니다.' });
};
