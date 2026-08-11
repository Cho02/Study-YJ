/**
 * /api/update — 최신 APK 버전 조회/등록 (Vercel Blob)
 * ------------------------------------------------------------------
 * GET /api/update
 *   최신 빌드 버전 정보를 반환한다 (앱 실행 시 버전 체크용).
 *   Blob "latest-version.json" 에 { versionCode, versionName, apkPath, notes } 가 저장되어 있다.
 *   apkPath → Blob head() 로 다운로드 가능한 apkUrl 을 만들어 함께 반환한다.
 *   응답: { "success": true, "latest": { "versionCode": N, "versionName": "...", "apkUrl": "...", "notes": "..." } }
 *   등록된 버전이 없으면: { "success": false, "latest": null }
 *
 * POST /api/update (관리자)
 *   최신 빌드 정보를 Blob 에 저장한다.
 *   요청: { "versionCode": N, "versionName": "...", "apkPath": "...", "notes": "..." }
 *   응답: { "success": true, "latest": { ... } }
 *   선택 보호: ADMIN_TOKEN env 가 설정돼 있으면 Authorization: Bearer <token> 요구.
 *   (실제 배포는 scripts/deploy-apk.js 로 APK 업로드 + 등록을 한 번에 수행)
 */
const { put, head, get } = require('@vercel/blob');

const VERSION_PATH = 'latest-version.json';

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

/** 관리자 인증 — ADMIN_TOKEN 이 설정된 경우에만 Bearer 토큰을 검사한다. */
function isAdmin(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return true; // 토큰 미설정이면 개인용 서비스로 간주하고 허용
  const header = req.headers.authorization || '';
  return header === `Bearer ${token}`;
}

/** Blob 에서 apkPath 의 다운로드 URL 을 조회한다. (private blob → 프록시 경로) */
async function resolveApkUrl(apkPath) {
  if (!apkPath) return null;
  const base = (process.env.VERCEL_URL || 'study-yj.vercel.app').replace(/^https?:\/\//, '');
  return `https://${base}/download-apk?path=${encodeURIComponent(apkPath)}`;
}

/** 최신 버전 정보를 Blob 에서 읽는다. 없으면 null. */
async function readLatest() {
  const info = await head(VERSION_PATH);
  if (!info) return null;
  const result = await get(VERSION_PATH, { access: 'private' });
  if (!result) return null;
  const text = await new Response(result.stream).text();
  const latest = JSON.parse(text);
  return {
    versionCode: Number(latest.versionCode) || 0,
    versionName: String(latest.versionName || ''),
    apkPath: String(latest.apkPath || ''),
    notes: latest.notes != null ? String(latest.notes) : '',
    uploadedAt: info.uploadedAt || null,
  };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    try {
      const latest = await readLatest();
      if (!latest) {
        return res.json({ success: false, latest: null });
      }
      const apkUrl = await resolveApkUrl(latest.apkPath);
      return res.json({
        success: true,
        latest: {
          versionCode: latest.versionCode,
          versionName: latest.versionName,
          apkUrl,
          notes: latest.notes,
        },
      });
    } catch (err) {
      console.error('[update] GET 실패:', err.message);
      return res.status(500).json({ success: false, latest: null, error: `버전 조회 실패: ${err.message}` });
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'GET 또는 POST 메서드만 허용됩니다.' });
  }

  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, error: '관리자 인증이 필요합니다.' });
  }

  const body = parseBody(req);
  const versionCode = Number(body.versionCode);
  const versionName = String(body.versionName || '').trim();
  const apkPath = String(body.apkPath || '').trim();
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    return res.status(400).json({ success: false, error: 'versionCode (양의 정수) 가 필요합니다.' });
  }
  if (!versionName) {
    return res.status(400).json({ success: false, error: 'versionName 이 필요합니다.' });
  }
  if (!apkPath) {
    return res.status(400).json({ success: false, error: 'apkPath 가 필요합니다.' });
  }

  try {
    const payload = {
      versionCode,
      versionName,
      apkPath,
      notes: body.notes != null ? String(body.notes) : '',
    };
    await put(VERSION_PATH, JSON.stringify(payload), {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
    });
    const apkUrl = await resolveApkUrl(apkPath);
    return res.json({
      success: true,
      latest: { versionCode, versionName, apkUrl, notes: payload.notes },
    });
  } catch (err) {
    console.error('[update] 등록 실패:', err.message);
    return res.status(500).json({ success: false, error: `버전 등록 실패: ${err.message}` });
  }
};
