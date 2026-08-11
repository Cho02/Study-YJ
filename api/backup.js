/**
 * /api/backup — Vercel Blob 기반 데이터 백업
 * ------------------------------------------------------------------
 * POST /api/backup
 *   study-app 로컬 전체 데이터(공부 기록 + 단어장 + SRS 상태)를 Blob에 저장한다.
 *   앱이 buildJson()으로 만든 JSON(studyRecords + vocabulary 배열)을 그대로 body로 전송한다.
 *   요청 본문: { "app": "study-app", "version": 1, "exportedAt": ..., "studyRecords": [...], "vocabulary": [...] }
 *   저장:     Blob "backup.json" (덮어쓰기)
 *   응답:     { "success": true, "savedAt": epochMs }
 *
 * GET /api/backup
 *   저장된 백업을 조회한다. 없으면 404.
 *   응답:     { "success": true, "records": [...], "vocab": [...], "savedAt": epochMs }
 */
const { put, head, get } = require('@vercel/blob');

const BACKUP_PATH = 'backup.json';

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
    try {
      const info = await head(BACKUP_PATH);
      if (!info) {
        return res.status(404).json({ success: false, error: '저장된 백업이 없습니다.' });
      }
      const blob = await get(BACKUP_PATH);
      const text = await blob.text();
      let stored;
      try {
        stored = JSON.parse(text);
      } catch (_) {
        return res.status(500).json({ success: false, error: '백업 파일이 손상되었습니다.' });
      }
      return res.json({
        success: true,
        records: Array.isArray(stored.studyRecords) ? stored.studyRecords : [],
        vocab: Array.isArray(stored.vocabulary) ? stored.vocabulary : [],
        savedAt: info.uploadedAt ? Date.parse(info.uploadedAt) : (stored.exportedAt || 0),
      });
    } catch (err) {
      console.error('[backup] GET 실패:', err.message);
      return res.status(500).json({ success: false, error: `백업 조회 실패: ${err.message}` });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'GET 또는 POST 메서드만 허용됩니다.' });
  }

  const body = parseBody(req);
  if (typeof body !== 'object' || body === null) {
    return res.status(400).json({ success: false, error: 'JSON 본문이 필요합니다.' });
  }
  const hasRecords = Array.isArray(body.studyRecords) || Array.isArray(body.records);
  const hasVocab = Array.isArray(body.vocabulary) || Array.isArray(body.vocab);
  if (!hasRecords && !hasVocab) {
    return res.status(400).json({ success: false, error: 'studyRecords/vocabulary 배열이 필요합니다.' });
  }

  try {
    // addRandomSuffix=false 로 고정 경로에 덮어쓰기 (버전별 백업이 아닌 최신 1개 유지)
    const blob = await put(BACKUP_PATH, JSON.stringify(body), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
    });
    const savedAt = blob.uploadedAt ? Date.parse(blob.uploadedAt) : Date.now();
    return res.json({ success: true, savedAt });
  } catch (err) {
    console.error('[backup] 저장 실패:', err.message);
    return res.status(500).json({ success: false, error: `백업 저장 실패: ${err.message}` });
  }
};
