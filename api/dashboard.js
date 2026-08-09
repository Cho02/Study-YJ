/**
 * GET /dashboard
 * ------------------------------------------------------------------
 * 노션 '공부 타이머 기록' DB의 전체 기록을 읽어 단일 HTML 대시보드로 렌더링한다.
 * 노션 페이지의 Embed 블록이 iframe으로 불러오므로,
 * 외부 스타일시트/스크립트 없이 인라인 CSS만 사용한다.
 */
const { queryStudyRecords } = require('../lib/notion');

const TIMEZONE = process.env.DASHBOARD_TIMEZONE || 'Asia/Seoul';

/** 서울(기본) 기준 오늘 날짜 문자열 YYYY-MM-DD */
function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA → 2026-08-09
}

function htmlEscape(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMin(m) {
  const total = Number(m) || 0;
  if (total < 60) return `${total}분`;
  const h = Math.floor(total / 60);
  const min = total % 60;
  return min === 0 ? `${h}시간` : `${h}시간 ${min}분`;
}

function computeStats(records, today) {
  const todayTotal = records
    .filter((r) => r.date === today)
    .reduce((sum, r) => sum + r.minutes, 0);

  const bySubject = {};
  for (const r of records) {
    bySubject[r.subject] = (bySubject[r.subject] || 0) + r.minutes;
  }
  const subjectRows = Object.entries(bySubject)
    .sort((a, b) => b[1] - a[1])
    .map(([subject, minutes]) => ({ subject, minutes }));

  // 최근 7일 (오늘 포함, 과거로 6일)
  const days = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    const minutes = records.filter((r) => r.date === dateStr).reduce((s, r) => s + r.minutes, 0);
    days.push({ date: dateStr, minutes });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.minutes));

  const recent = [...records]
    .sort((a, b) => (a.date === b.date ? (b.minutes - a.minutes) : (a.date < b.date ? 1 : -1)))
    .slice(0, 20);

  return { todayTotal, subjectRows, days, maxDay, recent };
}

function renderBarChart(days, maxDay) {
  const rows = days
    .map((d) => {
      const dayLabel = d.date.slice(5).replace('-', '/');
      const pct = d.minutes === 0 ? 2 : Math.max(8, Math.round((d.minutes / maxDay) * 100));
      const barColor = d.minutes === 0 ? '#e4e7ec' : d.date === todayStr() ? '#2f80ed' : '#56a0ee';
      const isToday = d.date === todayStr();
      return `
      <div class="bar-cell" title="${htmlEscape(d.date)} ${fmtMin(d.minutes)}">
        <div class="bar-track"><div class="bar" style="height:${pct}%;background:${barColor}"></div></div>
        <div class="bar-day${isToday ? ' today' : ''}">${dayLabel}</div>
      </div>`;
    })
    .join('');
  return `<div class="bar-chart">${rows}</div>`;
}

function renderTable(records) {
  if (records.length === 0) {
    return '<p class="empty">아직 기록이 없습니다.</p>';
  }
  const rows = records
    .map(
      (r) => `
      <tr>
        <td class="mono">${htmlEscape(r.date)}</td>
        <td>${htmlEscape(r.subject)}</td>
        <td class="num">${fmtMin(r.minutes)}</td>
        <td>${htmlEscape(r.source)}</td>
        <td class="memo">${htmlEscape(r.memo || '')}</td>
      </tr>`,
    )
    .join('');
  return `
  <table>
    <thead>
      <tr><th>날짜</th><th>과목</th><th>시간</th><th>소스</th><th>메모</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderDashboard(stats) {
  const { todayTotal, subjectRows, days, maxDay, recent } = stats;
  const subjectCards = subjectRows
    .map(
      (s) => `
      <div class="stat-card">
        <div class="stat-subject">${htmlEscape(s.subject)}</div>
        <div class="stat-value">${fmtMin(s.minutes)}</div>
      </div>`,
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>공부 기록 대시보드</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Segoe UI", Roboto, sans-serif;
    background: #f7f8fa; color: #1f2328; padding: 16px;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 700; margin-bottom: 12px; }
  h2 { font-size: 14px; font-weight: 600; color: #57606a; margin: 20px 0 8px; }
  .hero {
    background: linear-gradient(135deg, #2f80ed, #56a0ee);
    color: #fff; border-radius: 14px; padding: 18px 20px;
  }
  .hero-label { font-size: 13px; opacity: .85; }
  .hero-value { font-size: 30px; font-weight: 800; margin-top: 2px; }
  .stats { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
  .stat-card {
    flex: 1 1 120px; background: #fff; border: 1px solid #e8eaee;
    border-radius: 12px; padding: 12px 14px;
  }
  .stat-subject { font-size: 12px; color: #57606a; }
  .stat-value { font-size: 18px; font-weight: 700; margin-top: 2px; }
  .card { background: #fff; border: 1px solid #e8eaee; border-radius: 12px; padding: 14px 16px; }
  .bar-chart { display: flex; gap: 10px; align-items: flex-end; height: 140px; padding-top: 8px; }
  .bar-cell { flex: 1; display: flex; flex-direction: column; align-items: center; height: 100%; }
  .bar-track { flex: 1; width: 100%; display: flex; align-items: flex-end; justify-content: center; }
  .bar { width: 60%; max-width: 36px; border-radius: 4px 4px 0 0; min-height: 2px; transition: height .3s; }
  .bar-day { font-size: 11px; color: #6e7681; margin-top: 6px; }
  .bar-day.today { font-weight: 700; color: #2f80ed; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .03em; color: #8b949e; padding: 6px 8px; border-bottom: 2px solid #e8eaee; }
  td { padding: 7px 8px; border-bottom: 1px solid #f0f1f4; }
  td.num { font-variant-numeric: tabular-nums; text-align: right; }
  td.mono, td.memo { color: #57606a; }
  .empty { color: #8b949e; font-size: 13px; padding: 12px 0; }
  .foot { text-align: center; color: #8b949e; font-size: 11px; margin-top: 20px; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>📚 공부 기록 대시보드</h1>
    <div class="hero">
      <div class="hero-label">오늘 공부 시간</div>
      <div class="hero-value">${fmtMin(todayTotal)}</div>
    </div>
    <div class="stats">${subjectCards || '<div class="stat-card"><div class="stat-subject">기록 없음</div><div class="stat-value">0분</div></div>'}</div>
    <h2>최근 7일 공부 시간</h2>
    <div class="card">${renderBarChart(days, maxDay)}</div>
    <h2>최근 기록</h2>
    <div class="card">${renderTable(recent)}</div>
    <div class="foot">Notion 공부 기록 · ${new Intl.DateTimeFormat('ko-KR', { timeZone: TIMEZONE, dateStyle: 'long' }).format(new Date())} 갱신</div>
  </div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') {
    res.status(405).json({ success: false, error: 'GET 메서드만 허용됩니다.' });
    return;
  }

  let records;
  try {
    records = await queryStudyRecords();
  } catch (err) {
    console.error('[dashboard] 노션 조회 실패:', err.message);
    res.status(500).setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>오류</title></head><body><p>노션 DB 조회에 실패했습니다.</p><pre>${htmlEscape(err.message)}</pre></body></html>`);
    return;
  }

  const stats = computeStats(records, todayStr());
  const html = renderDashboard(stats);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
};
