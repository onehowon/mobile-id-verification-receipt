// 측정: 단계 수 비교와 검증 소요 시간 기록·CSV 내보내기.

// 단계 수 세는 기준(기획서 ④-4와 같음): 역할이 바뀌기 전까지 한 사람이 연속으로 하는 조작 묶음을 1단계로 센다.
// as-is: 공모전 붙임1의 QR 제시 절차(검증자·대상자가 번갈아 5회). CCTV 제출은 확인 단계가 아니라 '분쟁 때 입증' 행에서 비교한다.
export const STEPS_ASIS = [
  { step: 'QR 요청', who: '검증자' },
  { step: 'QR 제시', who: '대상자' },
  { step: '정보제공 요청', who: '검증자' },
  { step: '정보제공 동의', who: '대상자' },
  { step: '확인', who: '검증자' },
];

export const STEPS_TOBE = [
  { step: '[연령 확인] 누르기', who: '직원' },
  { step: 'QR 촬영 · 인증 · 보내기', who: '손님' },
  { step: '결과 확인 (영수증 자동 보관)', who: '직원' },
];

/** 단계 감소율(%): (as-is − to-be) ÷ as-is */
export const stepReduction = () => Math.round(((STEPS_ASIS.length - STEPS_TOBE.length) / STEPS_ASIS.length) * 100);

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
