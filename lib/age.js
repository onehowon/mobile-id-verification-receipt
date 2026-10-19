// 연 나이 판정: 청소년 보호법 제2조 제1호
// "'청소년'이란 19세 미만인 사람을 말한다. 다만, 19세가 되는 해의 1월 1일을 맞이한 사람은 제외한다."
// → 청소년 아님(not_youth) ⇔ 올해(한국 시각) − 출생연도 ≥ 19. 생일은 보지 않는다.

const KST_MS = 9 * 3600000;

/** 한국 시각(UTC+9) 기준 연도 */
export function kstYear(ms) {
  return new Date(ms + KST_MS).getUTCFullYear();
}

function birthYear(birthdate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!m) throw new Error('생년월일은 YYYY-MM-DD 형식이어야 합니다');
  return Number(m[1]);
}

/** 청소년 보호법상 청소년이 아닌지 (연 나이 기준) */
export function notYouth(birthdate, nowMs = Date.now()) {
  return kstYear(nowMs) - birthYear(birthdate) >= 19;
}

/** 다음 해 1월 1일 0시(KST)의 epoch 초. not_youth=false 증명의 만료 상한 */
export function nextJan1Kst(nowMs = Date.now()) {
  return (Date.UTC(kstYear(nowMs) + 1, 0, 1) - KST_MS) / 1000;
}

/** 그날 0시(KST)의 epoch 초. 1회용 증명의 iat를 하루 단위로 내려 시각으로 연결되지 않게 한다 */
export function kstMidnight(nowMs = Date.now()) {
  return Math.floor((nowMs + KST_MS) / 86400000) * 86400 - KST_MS / 1000;
}
