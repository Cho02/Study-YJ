/**
 * /reset-kanji-srs — 한자 카드 음독/훈독 SRS 일괄 초기화
 * ------------------------------------------------------------------
 * POST /reset-kanji-srs (x-hermes-secret 헤더 필요)
 *   → 노션 단어장 DB의 모든 한자 카드를 조회해 onyomi/kunyomi SRS를 초기값으로 되돌린다.
 *     meaning SRS는 유지된다.
 *   응답: { "success": true, "total": 35, "reset": 23, "skipped": 12, "message": "..." }
 *
 * GET  /reset-kanji-srs
 *   → {"method":"POST"} 안내 반환
 */
const { resetKanjiSrs } = require('../lib/notion');
const { setCors, handleOptions } = require('../lib/http');

const HERMES_SECRET = process.env.HERMES_SECRET;

module.exports = async function handler(req, res) {
  setCors(res, 'GET, POST, OPTIONS');
  if (handleOptions(req, res)) return;

  // GET은 안내
  if (req.method === 'GET') {
    return res.json({ method: 'POST', description: 'POST로 호출하면 한자 카드의 음독/훈독 SRS를 초기화합니다. x-hermes-secret 헤더가 필요합니다.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'POST만 허용됩니다.' });
  }

  // 인증 체크
  const secret = req.headers['x-hermes-secret'];
  if (!HERMES_SECRET || secret !== HERMES_SECRET) {
    return res.status(401).json({ success: false, error: '인증 실패 — x-hermes-secret 헤더가 올바르지 않습니다.' });
  }

  try {
    const result = await resetKanjiSrs();
    return res.json({
      success: true,
      total: result.total,
      reset: result.reset,
      skipped: result.skipped,
      message: `한자 ${result.reset}개 카드의 음독/훈독 SRS가 초기화되었습니다. (${result.skipped}개는 이미 초기 상태)`,
    });
  } catch (err) {
    console.error('[reset-kanji-srs] 실패:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
};
