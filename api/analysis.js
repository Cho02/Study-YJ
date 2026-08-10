/**
 * POST /api/analysis
 * ------------------------------------------------------------------
 * 앱의 로컬 공부 통계를 AI 모델로 "해석"해 지정된 JSON 양식으로 반환한다.
 *
 * AI는 계산을 하지 않는다. focusIndex/정답률/복습 밀림 수 등 숫자는
 * 앱/서버가 계산하고, AI는 받은 숫자만 양식에 맞춰 해석·조언을 작성한다.
 *
 * 모델 3단계 폴백 (안정성 우선 — 유료 Vercel Gemma를 1차 메인으로):
 *   1차  Vercel AI Gateway google/gemma-4-31b-it           (유료 — 안정적 구조화, 월 $5 한도 가드)
 *   2차  OpenRouter google/gemma-4-31b-it:free              (1차 실패 시, 무료)
 *   3차  OpenRouter nvidia/nemotron-3-ultra-550b-a55b:free  (2차도 실패 시, 무료 — 최후)
 *   1차(유료) 사용 시 서버 로그 기록 + 응답에 "paidFallback": true 표시 → 앱에서 유료 사용 안내
 *
 * 환경변수 (앱에 절대 노출 금지):
 *   OPENROUTER_API_KEY          OpenRouter 프리티어용
 *   VERCEL_AI_GATEWAY_KEY       Vercel AI Gateway 유료 메인 모델용 (또는 AI_GATEWAY_TOKEN / AI_GATEWAY_API_KEY)
 *   MAX_PAID_USD_PER_MONTH      유료 폴백 월 한도 (기본 5 = $5)
 *
 * AI가 JSON 스키마를 벗어나면 스키마 재시도 1회, 그래도 실패하면 실패 처리.
 */

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';

const MODEL_FREE_1 = 'google/gemma-4-31b-it:free';
const MODEL_FREE_2 = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const MODEL_PAID = 'google/gemma-4-31b-it';

const AI_TIMEOUT_MS = 15_000; // 모델 호출 1회당 타임아웃 (응답은 앱에서도 15초 초과 시 실패 처리)

// ── 유료 모델 월 한도 ($5) ──────────────────────────────────────
// Vercel 서버리스의 파일시스템은 기본적으로 읽기 전용이므로 /tmp에만 기록할 수 있다.
// /tmp는 인스턴스 수명 동안 유지되는 best-effort 카운터다 — 월 사용량의 정확한
// 기준은 Vercel 대시보드이며, 여기서는 예상치 기반 사전 차단 가드로만 동작한다.
// (프로덕션에서는 Vercel KV 등 영속 저장소로 교체 권장)
const MAX_PAID_USD_PER_MONTH = Number(process.env.MAX_PAID_USD_PER_MONTH) || 5;
const ESTIMATED_USD_PER_PAID_CALL = 0.0005; // gemma 계열 1회 대략 $0.0005 전후
const USAGE_FILE = '/tmp/ai-gateway-usage.json';
const fs = require('fs');

// ── 요청 본문 파싱 ──────────────────────────────────────────────
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

// ── 요약 통계 화이트리스트 (컨텍스트/입력 토큰 최소화) ─────────────
// 앱은 이미 주간 요약 수준의 stats를 보낸다. 여기서 한 번 더 걸러
// 알 수 없는/불필요한 필드(구버전 앱의 대량 배열 등)가 모델 프롬프트로
// 들어가는 것을 차단해 입력 토큰 비용을 낮춘다.
const STATS_WHITELIST = [
  'focusIndex',
  'focusTrend',
  'weeklyMinutes',
  'weeklyDiffMinutes',
  'dailyMinutes',
  'srsDistribution',
  'categorySummary',
  'studyBalance',
  'reviewBacklog',
];

function sanitizeStats(stats) {
  const out = {};
  for (const key of STATS_WHITELIST) {
    if (key in stats) out[key] = stats[key];
  }
  return out;
}

// ── 유료 모델 사용량 기록 ───────────────────────────────────────
function readUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
  } catch (_) { /* 재생 불가 시 리셋 */ }
  return { month: currentMonthKey(), spentUsd: 0, calls: 0 };
}

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7); // "2026-08"
}

function paidAllowed() {
  const usage = readUsage();
  if (usage.month !== currentMonthKey()) return { allowed: true, usage: null };
  const spent = Number(usage.spentUsd) || 0;
  const allowed = spent + ESTIMATED_USD_PER_PAID_CALL <= MAX_PAID_USD_PER_MONTH;
  return { allowed, usage };
}

function recordPaidCall() {
  const usage = readUsage();
  const month = currentMonthKey();
  if (usage.month !== month) usage.month = month, usage.spentUsd = 0, usage.calls = 0;
  usage.spentUsd = (Number(usage.spentUsd) || 0) + ESTIMATED_USD_PER_PAID_CALL;
  usage.calls = (Number(usage.calls) || 0) + 1;
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(usage)); } catch (_) { /* best-effort */ }
  console.warn(`[analysis] 유료 모델 사용 — 이번 달 예상 ${usage.spentUsd.toFixed(4)}$ (${usage.calls}회), 한도 $${MAX_PAID_USD_PER_MONTH}`);
}

// ── 모델 호출 (fetch, Node 18+) ────────────────────────────────
function callOpenAICompat(url, apiKey, payload) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }
        return res.json();
      })
      .then((json) => {
        const content = json?.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || !content.trim()) {
          throw new Error('모델 응답에 내용이 없습니다');
        }
        resolve(content.trim());
      })
      .catch((err) => reject(err))
      .finally(() => clearTimeout(timer));
  });
}

/** 2차: OpenRouter 무료 Gemma (1차 유료 실패 시) */
function callOpenRouterFree1(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return Promise.reject(new Error('OPENROUTER_API_KEY 미설정'));
  return callOpenAICompat(OPENROUTER_URL, key, {
    model: MODEL_FREE_1,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });
}

/** 3차: OpenRouter 무료 Nemotron (2차도 실패 시, 최후) */
function callOpenRouterFree2(prompt) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return Promise.reject(new Error('OPENROUTER_API_KEY 미설정'));
  return callOpenAICompat(OPENROUTER_URL, key, {
    model: MODEL_FREE_2,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  });
}

/** 1차: Vercel AI Gateway 유료 Gemma (메인 모델 — 안정성 우선, 월 $5 한도 가드) */
function callVercelPaid(prompt) {
  const key =
    process.env.VERCEL_AI_GATEWAY_KEY ||
    process.env.AI_GATEWAY_TOKEN ||
    process.env.AI_GATEWAY_API_KEY;
  if (!key) return Promise.reject(new Error('VERCEL_AI_GATEWAY_KEY 미설정'));
  return callOpenAICompat(GATEWAY_URL, key, {
    model: MODEL_PAID,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  });
}

// ── 프롬프트 생성 ───────────────────────────────────────────────
function buildPrompt(stats, meta, rules, isRetry) {
  const schema = [
    '{',
    '  "analysis": {',
    '    "focus": { "score": number /* stats.focusIndex 값 그대로 */, "trend": "상승세" | "유지" | "하락세" | "insufficient_data" /* stats.focusTrend 값 그대로 */, "comment": "한국어 한 문장" },',
    '    "balance": { "subject": "비중이 가장 큰 과목", "overweight": boolean, "comment": "한국어 한 문장" },',
    '    "srs": { "stagnant": ["정체된 레벨, 없으면 빈 배열"], "backlog": number /* stats.reviewBacklog 값 그대로 */, "comment": "한국어 한 문장" },',
    '    "burnout": { "risk": "낮음" | "보통" | "높음", "comment": "한국어 한 문장" },',
    '    "advice": "한국어 조언 2~3문장"',
    '  }',
    '}',
  ].join('\n');

  // meta 가드 룰 — 데이터 부족/신규 사용자/복습 밀림 없음 시 진단 제한
  const metaRules = [];
  if (meta && meta.focusTrendValid === false) {
    metaRules.push('focus.trend는 반드시 "insufficient_data"로 출력하세요.');
    metaRules.push('advice에 "최근 몰입도 변화 추이를 분석하기에는 학습 기록이 더 필요합니다" 문장을 반드시 포함하세요.');
  }
  if (meta && meta.isNewUser === true) {
    metaRules.push('이 사용자는 신규 사용자입니다. 과부하/번아웃/추이 진단을 하지 마세요.');
  }
  if (meta && meta.hasActiveBacklog === false) {
    metaRules.push('복습 밀림이 없습니다. 복습 밀림 관련 조언을 하지 마세요.');
  }

  // 규칙 엔진 결과 — "이미 결정된 조언" (AI가 바꾸거나 생략할 수 없다)
  const decidedAdvice = Array.isArray(rules) && rules.length > 0
    ? rules.map((r) => r.text).join(' ')
    : '';

  return [
    '당신은 공부 습관 분석가입니다. 아래 사용자의 공부 통계(JSON)를 받아 지정된 JSON 스키마에 맞춰 분석하세요.',
    '중요: AI는 계산하지 않습니다. score/backlog 등 숫자는 주어진 통계 값을 그대로 사용하고, 해석과 조언만 한국어로 작성하세요.',
    '절대 마크다운/코드 블록/추가 텍스트를 쓰지 말고, 유효한 JSON만 한 번에 반환하세요.',
    '출력할 JSON 스키마:',
    schema,
    '',
    '사용자 공부 통계:',
    JSON.stringify(stats),
    '',
    ...(metaRules.length > 0 ? ['규칙:', ...metaRules, ''] : []),
    ...(decidedAdvice
      ? ['이미 결정된 조언 (아래 내용은 이미 결정된 것입니다. advice에 반드시 그대로 포함하고, 내용을 바꾸거나 생략하지 마세요):', decidedAdvice, '']
      : []),
    isRetry
      ? '이전 응답이 스키마에 맞지 않았습니다. 위 스키마에 정확히 맞는 JSON만 출력하세요. 다른 텍스트는 절대 출력하지 마세요.'
      : '',
  ].filter((line) => line !== '').join('\n');
}

// ── 규칙 엔진 (결정적 조언 — AI가 바꾸지 못하는 부분) ─────────────
// 개선 4/5: 복습 밀림 / 주간 증감 / L1~L4 망각 위험(Retention Risk Score)을
// 결정적 템플릿으로 생성하고, LLM 응답의 advice에 병합한다.

/** srsDistribution에서 L1~L4 비율과 최악 카테고리 계산 */
function computeL1L4(srsDistribution) {
  if (!srsDistribution || typeof srsDistribution !== 'object') return { ratio: 0, worstCategory: null };
  let total = 0;
  let l1l4 = 0;
  let worstCategory = null;
  let worstRatio = -1;
  for (const [cat, levels] of Object.entries(srsDistribution)) {
    if (!levels || typeof levels !== 'object') continue;
    let catTotal = 0;
    let catL1L4 = 0;
    for (const [level, count] of Object.entries(levels)) {
      const n = Number(count) || 0;
      const lv = Number(String(level).replace('L', '')) || 0;
      catTotal += n;
      total += n;
      if (lv >= 1 && lv <= 4) {
        catL1L4 += n;
        l1l4 += n;
      }
    }
    if (catTotal > 0) {
      const r = catL1L4 / catTotal;
      if (r > worstRatio) {
        worstRatio = r;
        worstCategory = cat;
      }
    }
  }
  return { ratio: total > 0 ? l1l4 / total : 0, worstCategory };
}

function runRuleEngine(stats, meta) {
  const rules = [];

  // 복습 밀림 — 50개 초과 시 분산 조언
  const backlog = Number(stats && stats.reviewBacklog) || 0;
  if (backlog > 50) {
    rules.push({ key: '복습이 50개 이상', text: '복습이 50개 이상 밀렸습니다. 2~3일로 분산하세요.' });
  }

  // 주간 증감 — 이전 7일 대비 ±20% 이상 변동
  const weeklyMinutes = Number(stats && stats.weeklyMinutes) || 0;
  const weeklyDiff = Number(stats && stats.weeklyDiffMinutes) || 0;
  const prevWeek = weeklyMinutes - weeklyDiff; // 이전 7일 공부 시간
  if (prevWeek > 0) {
    if (weeklyDiff > 0.2 * prevWeek) {
      rules.push({ key: '20% 이상 증가', text: '지난주 대비 20% 이상 증가했습니다.' });
    } else if (weeklyDiff < -0.2 * prevWeek) {
      rules.push({ key: '20% 이상 감소', text: '지난주 대비 20% 이상 감소했습니다.' });
    }
  }

  // L1~L4 망각 위험 — 신규 사용자는 모든 카드가 L1~L4라 진단 제외
  const isNewUser = Boolean(meta && meta.isNewUser);
  if (!isNewUser) {
    const { ratio, worstCategory } = computeL1L4(stats && stats.srsDistribution);
    if (ratio >= 0.6) {
      const text = worstCategory
        ? `새 단어를 외우는 속도보다 잊어버리는 속도가 빠릅니다. 카테고리 ${worstCategory}의 복습 주기를 당기세요.`
        : '새 단어를 외우는 속도보다 잊어버리는 속도가 빠릅니다. 복습 주기를 당기세요.';
      rules.push({ key: '복습 주기를 당기세요', text });
    }
  }

  return rules;
}

/** 규칙 결과를 AI 응답 advice에 병합 — key가 advice에 없으면 앞에 추가 */
function mergeRules(analysis, rules, meta) {
  if (!analysis || typeof analysis.advice !== 'string') return analysis;
  const missing = (Array.isArray(rules) ? rules : []).filter(
    (r) => !analysis.advice.includes(r.key),
  );
  const parts = missing.map((r) => r.text);
  if (meta && meta.focusTrendValid === false &&
      !analysis.advice.includes('학습 기록이 더 필요합니다')) {
    parts.push('최근 몰입도 변화 추이를 분석하기에는 학습 기록이 더 필요합니다.');
  }
  if (parts.length > 0) {
    analysis.advice = [...parts, analysis.advice].join(' ');
  }
  return analysis;
}

// ── 응답 JSON 추출 + 스키마 검증 ────────────────────────────────
function extractJson(text) {
  // 마크다운 코드 펜스 제거 후, 첫 { 부터 마지막 } 까지 잘라낸다
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('JSON을 찾을 수 없습니다');
  return JSON.parse(candidate.slice(start, end + 1));
}

function validateAnalysis(parsed) {
  const a = parsed && parsed.analysis;
  if (!a || typeof a !== 'object') throw new Error('analysis 객체가 없습니다');
  const f = a.focus;
  const b = a.balance;
  const s = a.srs;
  const bu = a.burnout;
  const checks = [
    f && typeof f.score === 'number',
    f && typeof f.trend === 'string' && f.trend.length > 0,
    f && typeof f.comment === 'string' && f.comment.length > 0,
    b && typeof b.subject === 'string' && b.subject.length > 0,
    b && typeof b.overweight === 'boolean',
    b && typeof b.comment === 'string' && b.comment.length > 0,
    s && Array.isArray(s.stagnant) && s.stagnant.every((x) => typeof x === 'string'),
    s && typeof s.backlog === 'number',
    s && typeof s.comment === 'string' && s.comment.length > 0,
    bu && typeof bu.risk === 'string' && bu.risk.length > 0,
    bu && typeof bu.comment === 'string' && bu.comment.length > 0,
    typeof a.advice === 'string' && a.advice.length > 0,
  ];
  if (checks.some((ok) => !ok)) throw new Error('AI 응답이 스키마에 맞지 않습니다');
  return a;
}

// ── 메인 핸들러 ─────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS (어플에서 직접 호출 가능하도록)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, error: 'POST 메서드만 허용됩니다.' });
    return;
  }

  const body = parseBody(req);
  const rawStats = body && body.stats && typeof body.stats === 'object' ? body.stats : null;
  if (!rawStats) {
    return res.status(400).json({ success: false, error: 'stats 객체가 필요합니다.' });
  }

  // 입력 토큰 절감 — 앱이 보낸 요약 통계 중 화이트리스트 필드만 모델로 전달한다
  const stats = sanitizeStats(rawStats);
  const meta = body && body.meta && typeof body.meta === 'object' ? body.meta : {};
  const rules = runRuleEngine(stats, meta);

  const paidGuard = paidAllowed();
  if (!paidGuard.allowed) {
    console.error('[analysis] 유료 모델 월 $5 한도 초과 — AI 분석 중단');
    return res.status(503).json({
      success: false,
      error: 'AI 분석 불가: 유료 모델 월 한도($5)를 초과했습니다.',
    });
  }

  // 스키마 재시도 1회 포함 최대 2회 시도
  let paidFallback = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildPrompt(stats, meta, rules, attempt === 1);

    // 3단계 폴백 순서로 시도 — 1차 유료 Vercel Gemma, 실패 시 무료 프리티어로 폴백
    const tiers = [
      {
        name: 'vercel-ai-gateway-paid',
        call: () => callVercelPaid(prompt),
        paid: true,
      },
      { name: 'openrouter-gemma-free', call: () => callOpenRouterFree1(prompt) },
      { name: 'openrouter-nemotron-free', call: () => callOpenRouterFree2(prompt) },
    ];

    let content = null;
    for (const tier of tiers) {
      try {
        content = await tier.call();
        paidFallback = Boolean(tier.paid);
        if (paidFallback) recordPaidCall();
        break;
      } catch (err) {
        console.warn(`[analysis] ${tier.name} 실패 (${attempt + 1}차 시도): ${err.message}`);
        // 유료 1차가 429/실패해도 다음 무료 단계로 계속 폴백한다
        // (월 한도 초과 시도는 위 paidAllowed() 가드가 미리 차단한다)
      }
    }

    if (content == null) break; // 모든 단계 실패 → 다음 시도해도 소용없음

    try {
      const analysis = validateAnalysis(extractJson(content));
      // 규칙 엔진 결과를 AI 응답 advice에 병합 (AI가 생략/변경한 규칙 조언 보강)
      mergeRules(analysis, rules, meta);
      return res.json({
        success: true,
        paidFallback,
        analysis,
      });
    } catch (err) {
      console.warn(`[analysis] 응답 파싱/검증 실패 (${attempt + 1}차): ${err.message}`);
      // 스키마 재시도 1회 후에도 실패하면 실패 처리
    }
  }

  return res.status(502).json({
    success: false,
    error: 'AI 분석을 생성하지 못했습니다. 잠시 후 다시 시도해주세요.',
  });
};
