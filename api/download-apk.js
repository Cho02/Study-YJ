/**
 * /api/download-apk — Blob APK 프록시 다운로드
 * ------------------------------------------------------------------
 * GET /api/download-apk?path=apk/study-app-v9.apk
 *   Blob의 private APK를 서버사이드에서 읽어 스트리밍으로 전달한다.
 *   앱은 이 URL로 APK를 다운로드한다.
 */
const { get } = require('@vercel/blob');
const { setCors, handleOptions } = require('../lib/http');

module.exports = async function handler(req, res) {
  setCors(res, 'GET, OPTIONS');
  if (handleOptions(req, res)) return;

  const path = req.query.path || '';
  if (!path || !path.startsWith('apk/') || !path.endsWith('.apk')) {
    return res.status(400).json({ success: false, error: 'path 파라미터가 올바르지 않습니다.' });
  }

  try {
    const result = await get(path, { access: 'private' });
    if (!result) {
      return res.status(404).json({ success: false, error: 'APK를 찾을 수 없습니다.' });
    }
    const { Readable } = require('stream');
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${path.split('/').pop()}"`);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    Readable.fromWeb(result.stream).pipe(res);
  } catch (err) {
    console.error('[download-apk] 실패:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};
