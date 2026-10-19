// 시연 장면 정의와 화면 문구. DOM이 없는 순수 데이터·함수라 Node 테스트로 확인한다.

// focus: 좁은 화면(폰 한 대만 보일 때) 이 장면에서 보여 줄 폰. ms: 자동 재생 시 머무는 시간.
export const SCENES = [
  {
    id: 'adult', title: '연령 확인', left: '손님 폰', right: '매장 폰',
    beats: [
      { focus: 'right', ms: 7000, narr: '손님이 술을 주문했어요. 직원은 신분증 화면을 눈으로 보는 대신 검증앱에서 [연령 확인]을 눌러요. 요청에는 이 판매 번호가 묶여요.' },
      { focus: 'left', ms: 6000, scan: true, narr: '손님은 모바일 신분증 앱으로 매장 화면의 QR을 찍어요. 앱은 이 매장이 방금 띄운 1회용 요청인지 확인해요.' },
      { focus: 'left', ms: 8000, narr: '손님 앱은 보내기 전에 무엇이 나가는지 보여 줘요. 청소년이 아닌지(연 나이 기준) 하나뿐이고, 이 판매 한 건에만 쓰여요.' },
      { focus: 'right', ms: 9000, narr: '매장 폰에는 결과만 떠요. 손님 앱의 1회용 서명이 담긴 영수증이 저장되고 원장에 기록돼요. 이름과 생년월일은 남지 않아요.' },
    ],
  },
  {
    id: 'forgery', title: '위조 화면', left: '손님 폰', right: '매장 폰',
    beats: [
      { focus: 'left', ms: 7000, narr: '미성년자가 친구 화면을 캡처해 생년월일을 고쳐 왔어요. 눈으로는 구별하기 어려워요.' },
      { focus: 'right', ms: 9000, attack: 'birth', narr: '검증앱은 글자가 아니라 서명을 봐요. 고친 값은 발급 당시 값과 맞지 않아 바로 걸려요.' },
      { focus: 'right', ms: 8000, attack: 'forge', narr: '위조 앱이 매장 요청에 맞춰 스스로 서명해도 발급기관 키가 아니라서 통과하지 못해요.' },
      { focus: 'right', ms: 8000, attack: 'replay', narr: '남이 이미 쓴 QR을 다시 보여 줘도 막혀요. 요청은 한 번만 쓸 수 있어요.' },
    ],
  },
  {
    id: 'audit', title: '3개월 뒤 단속', left: '업주 폰', right: '구청 단속 담당',
    beats: [
      { focus: 'right', ms: 8000, narr: '약 3개월 뒤, 구청이 미성년자 판매 신고를 받고 단속을 나왔어요. 지금은 업주가 확인했다는 걸 입증하기 어려워요.' },
      { focus: 'left', ms: 7000, narr: '업주는 신고된 판매 번호의 영수증을 제출해요. 결과·시각과 손님 앱의 1회용 서명만 있고 개인정보는 없어요.' },
      { focus: 'right', ms: 9000, narr: '구청은 서버에 묻지 않고 발급기관·손님·매장 서명과 원장 기록을 다시 검사해요. 이 판매에서 연령을 확인한 사실이 입증돼요.' },
      { focus: 'right', ms: 9000, owner: true, narr: '업주가 매장 키로 영수증을 직접 만들거나 N을 Y로 고쳐도 통과하지 못해요. 손님과 발급기관의 서명은 만들 수 없어요.' },
    ],
  },
  {
    id: 'compare', title: '지금 vs 바뀐 뒤', layout: 'compare',
    beats: [
      { ms: 13000, narr: '위조 앱은 통과하지 못하고, 판매마다 업주 혼자 만들 수 없는 증거가 남아요. 시간은 이 기기에서 잰 값이에요.' },
    ],
  },
  {
    id: 'sealed', title: '확장: 봉인 사본', short: '봉인 사본', left: '손님 폰', right: '가상 구청 민원실',
    beats: [
      { focus: 'left', ms: 6000, narr: '같은 구조로 공공기관에 내는 사본도 만들 수 있어요. 받는 기관과 기한을 서명에 묶어요.' },
      { focus: 'right', ms: 6000, narr: '기관은 기한 안에서만 사본을 확인할 수 있어요.' },
      { focus: 'right', ms: 6000, narr: '기한이 지나면 이 사본은 검증에서 무효로 나와요. 누가, 어떤 목적으로 받았는지도 사본에 서명으로 묶여 있어요.' },
    ],
  },
];

export const TOTAL_MS = SCENES.reduce((a, s) => a + s.beats.reduce((b, x) => b + x.ms, 0), 0);

export function clampPos({ s, b }) {
  const si = Math.max(0, Math.min(SCENES.length - 1, Number.isFinite(s) ? s : 0));
  const n = SCENES[si].beats.length;
  return { s: si, b: Math.max(0, Math.min(n - 1, Number.isFinite(b) ? b : 0)) };
}

/** 다음 위치. 마지막이면 null */
export function nextPos({ s, b }) {
  if (b + 1 < SCENES[s].beats.length) return { s, b: b + 1 };
  if (s + 1 < SCENES.length) return { s: s + 1, b: 0 };
  return null;
}

/** 이전 위치. 처음이면 null */
export function prevPos({ s, b }) {
  if (b > 0) return { s, b: b - 1 };
  if (s > 0) return { s: s - 1, b: SCENES[s - 1].beats.length - 1 };
  return null;
}

/** 전체 진행 중 몇 번째 장면 조각인지 (1부터) */
export function beatIndex({ s, b }) {
  let n = 0;
  for (let i = 0; i < s; i++) n += SCENES[i].beats.length;
  return n + b + 1;
}
export const BEAT_COUNT = SCENES.reduce((a, s) => a + s.beats.length, 0);

/** ?scene=2&beat=1 (1부터) → 위치 */
export function posFromQuery(search) {
  const q = new URLSearchParams(search);
  return clampPos({ s: Number(q.get('scene') || 1) - 1, b: Number(q.get('beat') || 1) - 1 });
}

// 검증 실패를 매장 직원이 읽을 문장으로. 큰 문구 하나 + 이유 한 줄.
const FAILURE_COPY = {
  disclosure: { head: '발급 당시 정보와 달라요', sub: '생년월일이나 연령 값이 고쳐졌어요.' },
  issuer_sig: { head: '발급기관 서명이 확인되지 않아요', sub: '정식 발급기관이 아닌 앱에서 만든 신분증이에요.' },
  holder_binding: { head: '본인 기기에서 보낸 것이 아니에요', sub: '다른 사람의 신분증을 복사한 것으로 보여요.' },
  audience: { head: '이 매장에 보낸 것이 아니에요', sub: '다른 곳에서 받은 화면을 다시 보여 준 것 같아요.' },
  validity: { head: '유효기간이 지난 신분증이에요', sub: '발급기관에서 다시 발급받아야 해요.' },
  freshness: { head: '시간이 지난 요청이에요', sub: '새 QR로 다시 확인해 주세요.' },
  claim: { head: '연령 정보가 없어요', sub: '요청한 항목이 들어 있지 않아요.' },
  tx_binding: { head: '이 판매의 요청이 아니에요', sub: '다른 거래에 쓰려던 응답이에요.' },
  format: { head: '신분증 형식이 아니에요', sub: '서명된 신분증 정보가 아니에요.' },
};
const NONCE_COPY = {
  used: { head: '이미 사용한 QR이에요', sub: '캡처한 화면은 다시 쓸 수 없어요.' },
  unknown: { head: '이 매장이 띄운 QR이 아니에요', sub: '다른 곳의 요청을 가져온 것 같아요.' },
  expired: { head: '시간이 지난 QR이에요', sub: '새 QR로 다시 확인해 주세요.' },
};

export function failureCopy(report) {
  if (!report || report.ok) return null;
  if (report.failed === 'nonce') {
    const r = report.reason || '';
    if (r.includes('이미 사용')) return NONCE_COPY.used;
    if (r.includes('유효시간')) return NONCE_COPY.expired;
    return NONCE_COPY.unknown;
  }
  return FAILURE_COPY[report.failed] || { head: '확인되지 않았어요', sub: report.reason || '' };
}

// 구청 재검증 실패를 한 줄로 (영수증 v2 검사 id)
const RECEIPT_FAILURE = {
  format: '손님 제시물 없이 만든 영수증이에요',
  store_cert: '등록된 매장의 영수증이 아니에요',
  store_sig: '매장 서명이 맞지 않아요',
  issuer_sig: '발급기관 서명이 아니에요',
  validity_at: '만료된 증명으로 만든 영수증이에요',
  disclosure: '허용되지 않은 항목이 들어 있어요',
  holder_binding: '손님 서명이 맞지 않아요',
  audience: '다른 매장에 낸 제시물이에요',
  nonce: '이 매장 요청의 응답이 아니에요',
  tx_binding: '이 판매의 영수증이 아니에요',
  time: '손님 폰 서명 시각과 달라요',
  anchor: '원장 기록과 맞지 않아요',
  result: '발급기관 판정과 결과가 달라요',
  single_use: '같은 증명을 다시 썼어요',
  retention: '보관 기한이 지났어요',
};
export function receiptFailureLine(report) {
  if (!report || report.ok) return null;
  return RECEIPT_FAILURE[report.failed] || '확인되지 않았어요';
}

/** 한국 시각 「2026.10.19 21:42」 (기기 시간대와 무관) */
export function formatKst(ms, { time = true } = {}) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const d = `${p.year}.${p.month}.${p.day}`;
  return time ? `${d} ${p.hour}:${p.minute}` : d;
}

export function formatMs(v) {
  if (typeof v !== 'number') return '-';
  return v < 10 ? `${v.toFixed(2)}ms` : `${v.toFixed(0)}ms`;
}

/** 긴 토큰을 앞뒤만 남겨 줄인다 */
export function ellipsis(s, head = 28, tail = 10) {
  const str = String(s ?? '');
  return str.length > head + tail + 1 ? `${str.slice(0, head)}…${str.slice(-tail)}` : str;
}
