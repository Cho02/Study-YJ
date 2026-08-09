/**
 * GET /api/health
 * ------------------------------------------------------------------
 * 어플의 노션 연동 상태 판단용 헬스체크.
 * 서버리스가 살아 있고 노션 API 키가 설정되어 있으면 200을 반환한다.
 *
 * 응답: { "ok": true, "service": "study-sync", "time": "..." }
 */
module.exports = function handler(req, res) {
  const notionConfigured = Boolean(process.env.NOTION_API_KEY);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({
    ok: true,
    service: 'study-sync',
    notionConfigured,
    time: new Date().toISOString(),
  });
};
