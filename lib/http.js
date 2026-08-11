/**
 * HTTP 핸들러 공통 헬퍼 — CORS/OPTIONS/요청 본문 파싱/관리자 인증.
 * serverless 함수(api/*.js)들이 각자 중복으로 갖고 있던 코드를 한곳으로 모은 것.
 */

/** CORS 헤더 설정 — methods 는 허용할 메서드 목록 (기본: GET, POST, OPTIONS) */
function setCors(res, methods = 'GET, POST, OPTIONS') {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

/** OPTIONS preflight 요청이면 204 로 끝내고 true 반환 (아니면 false) */
function handleOptions(req, res) {
  if (req.method !== 'OPTIONS') return false;
  res.status(204).end();
  return true;
}

/**
 * 요청 본문 파싱.
 * 이미 파싱된 객체면 그대로, 문자열/버퍼 JSON 이면 JSON.parse, 파싱 불가 시 {} 반환.
 */
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

/**
 * 관리자 인증 — ADMIN_TOKEN 이 설정된 경우에만 Bearer 토큰을 검사한다.
 * 토큰 미설정이면 개인용 서비스로 간주하고 항상 허용.
 */
function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true;
  const header = req.headers.authorization || '';
  return header === `Bearer ${token}`;
}

module.exports = { setCors, handleOptions, parseBody, isAdmin };
