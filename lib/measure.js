// 측정: 단계 수 비교와 검증 소요 시간 기록·CSV 내보내기.

export const STEPS_ASIS = [
  { step: '손님이 신분증 화면 제시', who: '손님' },
  { step: '직원이 화면 육안 확인 (사진·생년월일)', who: '직원' },
  { step: '의심되면 검증앱 실행', who: '직원' },
  { step: '검증앱으로 QR 스캔·결과 확인', who: '직원' },
  { step: '분쟁 시 CCTV 영상 찾아 제출', who: '업주' },
];

export const STEPS_TOBE = [
  { step: '검증앱으로 QR 1회 스캔', who: '직원' },
  { step: '결과 Y/N 확인 (영수증 자동 보관, 분쟁 시 제출)', who: '직원' },
];

export const CSV_COLUMNS = ['time', 'scenario', 'outcome', 'failed_check', 'parse_ms', 'issuer_sig_ms', 'disclosure_ms', 'holder_binding_ms', 'nonce_ms', 'receipt_ms', 'total_ms', 'user_agent'];

export function toRow({ scenario, outcome, report, at = Date.now(), ua = '' }) {
  const t = report.timings || {};
  const f = (v) => (typeof v === 'number' ? Number(v.toFixed(3)) : '');
  return {
    time: new Date(at).toISOString(),
    scenario,
    outcome,
    failed_check: report.failed || '',
    parse_ms: f(t.parse),
    issuer_sig_ms: f(t.issuer_sig),
    disclosure_ms: f(t.disclosure),
    holder_binding_ms: f(t.holder_binding),
    nonce_ms: f(t.nonce),
    receipt_ms: f(t.receipt),
    total_ms: f(t.total),
    user_agent: ua,
  };
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLUMNS.join(','), ...rows.map((r) => CSV_COLUMNS.map((c) => esc(r[c])).join(','))].join('\n');
}

export function summarize(values) {
  const v = values.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const q = (p) => v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)];
  return { n: v.length, mean: v.reduce((a, b) => a + b, 0) / v.length, median: q(0.5), p95: q(0.95), min: v[0], max: v[v.length - 1] };
}
