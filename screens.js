// 장면별 폰 화면을 Ionic(iOS 모드) 마크업으로 만든다. 값은 모두 lib/demo-flow.js가 실제로 계산한 결과(D)에서 온다.
// 결과는 iframe(phone.html)으로 보내 그 안에서만 Ionic 스타일이 적용된다.
import { decodeJws } from './lib/jose.js';
import { RETENTION_DAYS } from './lib/receipt.js';
import { DEFAULT_PURPOSE } from './lib/verifier.js';
import { SCENES, failureCopy, formatKst, ellipsis } from './lib/scenes.js';
import * as flow from './lib/demo-flow.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = flow.DAY_MS;
const P = flow.PEOPLE;
const STORE = flow.STORE.name;
const AGENCY = flow.AGENCY.name;
export const hhmm = (ms) => formatKst(ms).slice(11);
export const ymd = (ms) => formatKst(ms, { time: false });
const birthDot = (s) => s.replaceAll('-', '.');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const dayLabel = (ms) => `${ymd(ms)} (${WD[new Date(ms + 9 * 3600000).getUTCDay()]})`;

const WALLET = '모바일 신분증 (데모)';
const VERIFIER = '검증앱 (데모)';

// ---------- 아이콘 (인라인 SVG, 장식 없음) ----------
const ICON_OK = '<svg class="result-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="currentColor"/><path d="M19 33l9 9 17-19" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BAD = '<svg class="result-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="32" fill="currentColor"/><path d="M22 22l20 20M42 22L22 42" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>';
const CHECK = '<svg class="svg-mark svg-ok" slot="end" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const PERSON = '<svg viewBox="0 0 46 52" aria-hidden="true"><circle cx="23" cy="17" r="11"/><path d="M0 52c0-13 10-21 23-21s23 8 23 21z"/></svg>';

// ---------- 조각 ----------
export function qr(text, cls = '') {
  let inner = '<div class="qr-missing">QR 라이브러리를<br>불러오지 못했어요</div>';
  if (globalThis.qrcode) {
    try {
      const q = globalThis.qrcode(0, 'L');
      q.addData(text);
      q.make();
      inner = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch { /* 너무 긴 데이터: 안내 문구 유지 */ }
  }
  return `<div class="qr ${cls}" role="img" aria-label="QR 코드">${inner}</div>`;
}

/** iOS 앱 한 화면: 앱 이름 내비게이션 바 + 큰 제목 + 내부 스크롤 본문 + 하단 고정 버튼 + (선택) 바텀시트 */
function page({ app, title, sub, body, footer, sheet }) {
  return `<div class="ion-page">
  <ion-header><ion-toolbar><ion-title>${esc(app)}</ion-title></ion-toolbar></ion-header>
  <ion-content>
    <h1 class="large-title">${esc(title)}</h1>
    ${sub ? `<p class="page-sub">${esc(sub)}</p>` : ''}
    ${body}
  </ion-content>
  ${footer ? `<ion-footer><ion-toolbar>${footer}</ion-toolbar></ion-footer>` : ''}
  ${sheet ? `<ion-modal data-sheet="auto" aria-label="보낼 정보 확인"><div class="sheet">${sheet}</div></ion-modal>` : ''}
</div>`;
}

const button = (label, { act = 'next', fill = 'solid', disabled = false } = {}) =>
  `<ion-button expand="block" size="large" fill="${fill}"${act ? ` data-act="${act}"` : ''}${disabled ? ' disabled="true"' : ''}>${esc(label)}</ion-button>`;

const group = (label, items, foot) =>
  `${label ? `<p class="group-label">${esc(label)}</p>` : ''}<ion-list inset="true">${items.join('')}</ion-list>${foot ? `<p class="group-foot">${esc(foot)}</p>` : ''}`;

/** 한 줄 항목: 왼쪽 제목(+보조), 오른쪽 값·배지 */
function item(main, { sub, note, badge, tone, mark, cls = '' } = {}) {
  const end = badge
    ? `<ion-badge slot="end" class="${tone === 'ok' ? 'soft-ok' : tone === 'bad' ? 'soft-bad' : 'soft'}">${esc(badge)}</ion-badge>`
    : note ? `<ion-note slot="end" class="${tone === 'strong' ? 'strong' : ''}">${esc(note)}</ion-note>` : '';
  return `<ion-item lines="full" class="${cls}"><ion-label>${sub ? `<h3>${esc(main)}</h3><p>${esc(sub)}</p>` : `<h3>${esc(main)}</h3>`}</ion-label>${end}${mark || ''}</ion-item>`;
}

function result(ok, { label, title, sub }) {
  return `<div class="result ${ok ? 'is-ok' : 'is-bad'}" role="status">${ok ? ICON_OK : ICON_BAD}
    <ion-badge class="${ok ? 'soft-ok' : 'soft-bad'}">${esc(label)}</ion-badge>
    <p class="result-title">${esc(title)}</p>${sub ? `<p class="result-sub">${esc(sub)}</p>` : ''}</div>`;
}

function idCard(person, { birth, edited, top = '모바일 신분증 · 가상' } = {}) {
  return `<div class="idcard"><div class="idcard-top"><span>${esc(top)}</span><ion-badge class="soft">데모</ion-badge></div>
    <div class="idcard-body"><div class="idcard-photo">${PERSON}</div><div><p class="idcard-name">${esc(person.name)}</p>
    <dl><dt>생년월일</dt><dd${edited ? ' class="edited"' : ''}>${esc(birth || birthDot(person.birthdate))}</dd><dt>발급</dt><dd>가상 발급기관</dd></dl></div></div></div>`;
}

const waiting = (t) => `<div class="waiting"><ion-spinner name="lines-small"></ion-spinner><span>${esc(t)}</span></div>`;

// ---------- 가운데 「오간 정보」 ----------
function wire(dir, from, to, main, sub, bad = false) {
  return `<div class="wire-item" data-dir="${dir}">
    <p class="wire-dir">${dir === 'left'
    ? `<span>${esc(to)}</span><span class="wire-arrow" aria-hidden="true"></span><span>${esc(from)}</span>`
    : `<span>${esc(from)}</span><span class="wire-arrow" aria-hidden="true"></span><span>${esc(to)}</span>`}</p>
    <div class="wire-box${bad ? ' is-bad' : ''}"><p class="wire-main">${esc(main)}</p>${sub ? `<p class="wire-sub">${esc(sub)}</p>` : ''}</div></div>`;
}
const idle = (t = '아직 주고받은 정보가 없어요') => `<p class="wire-idle">${esc(t)}</p>`;

// ---------- 장면 ① 성인 확인 ----------
function sceneAdult(D, b) {
  const now = D.adult?.at || D.req1At || Date.now();
  const t = hhmm(now);
  let left, right, w;

  if (b < 2) {
    left = page({
      title: '내 신분증', app: WALLET,
      body: `${idCard(P.adult)}${group('제출 내역', [item('아직 제출한 내역이 없어요', {})])}`,
      footer: button('QR 스캔', { act: '', fill: 'outline', disabled: b === 1 }),
      sheet: b === 1 ? `<p class="lead">${esc(STORE)}에<br>'만 19세 이상' 여부만 보내요</p>
        ${group('보내는 정보', [item('만 19세 이상인지', { sub: '예 / 아니오 하나', mark: CHECK })])}
        ${group('보내지 않는 정보', [item('이름 · 생년월일 · 주소', { cls: 'give-no' })], `목적: ${DEFAULT_PURPOSE} · 한 번만 쓰는 요청이에요`)}
        <div class="sheet-btn">${button('보내기')}</div>` : '',
    });
  } else {
    left = page({
      title: '제출 내역', app: WALLET,
      body: `${group(ymd(D.adult.at), [item(STORE, { sub: `만 19세 이상 여부 · ${hhmm(D.adult.at)}`, badge: '보냄', tone: 'ok' })])}
        ${group('보낸 정보', [item('만 19세 이상인지', { note: '예', tone: 'strong' }), item('이름 · 생년월일 · 주소', { note: '안 보냄' })], '매장에는 결과만 남고, 이 기기에는 제출 기록만 남아요.')}`,
    });
  }

  if (b === 0) {
    right = page({
      title: '확인 요청', app: VERIFIER, sub: STORE,
      body: `<p class="lead">어떤 확인이 필요하세요?</p>${group('', [
        item('성인 확인', { sub: '만 19세 이상인지만 받아요', mark: CHECK }),
        item('본인 확인', { sub: '이 데모에서는 쓰지 않아요', cls: 'give-no' }),
      ])}`,
      footer: button('성인 확인'),
    });
    w = idle();
  } else if (b === 1) {
    right = page({
      title: 'QR 보여 주기', app: VERIFIER, sub: STORE,
      body: `<div class="qr-card">${qr(JSON.stringify(D.req1))}${waiting('손님 응답을 기다리고 있어요')}</div>
        ${group('', [item('확인 항목', { note: '만 19세 이상' }), item('유효 시간', { note: '2분 · 1회용' })])}`,
    });
    w = wire('left', '매장 폰', '손님 폰', '요청: 만 19세 이상 여부', '1회용 번호가 들어 있어요');
  } else {
    const ok = D.adult.out.report.ok && D.adult.out.result === 'Y';
    right = page({
      title: '확인 결과', app: VERIFIER, sub: STORE,
      body: ok
        ? `${result(true, { label: '확인 완료', title: '만 19세 이상 확인됨', sub: '이름과 생년월일은 받지 않았어요.' })}
           ${group('', [item('영수증', { badge: '저장됨', tone: 'ok' }), item('개인정보', { note: '없음' }), item('확인 시각', { note: hhmm(D.adult.at) })])}`
        : result(false, { label: '확인 실패', ...failureCopy(D.adult.out.report) }),
      footer: button('확인'),
    });
    w = wire('right', '손님 폰', '매장 폰', '만 19세 이상 = 예', '이름·생년월일은 보내지 않았어요');
  }
  return { left, right, wire: w, time: [t, t] };
}

// ---------- 장면 ② 위조 화면 ----------
function attackLeft(kind, prep) {
  if (kind === 'birth') {
    return page({
      title: '내 신분증', app: WALLET,
      body: `<span class="tagline">캡처 화면 · 생년월일을 고침</span>${idCard(P.minor, { birth: '2000.01.01', edited: true })}
        <p class="idcard-note">원래 생년월일은 ${esc(birthDot(P.minor.birthdate))}이에요.</p><div class="qr-card">${qr(prep.vp, 'small')}</div>`,
    });
  }
  if (kind === 'forge') {
    return page({
      app: '모바일 신분증 (위조 앱)', title: '내 신분증',
      body: `<span class="tagline">겉모습은 진짜 앱과 똑같아요</span>${idCard({ name: '홍길동' }, { birth: '1990.01.01' })}<div class="qr-card">${qr(prep.vp, 'small')}</div>`,
    });
  }
  return page({
    app: '사진 앨범', title: '사진', sub: '저장한 캡처 1장',
    body: `<span class="tagline">다른 사람이 이미 쓴 QR</span><div class="photo">${qr(prep.vp, 'small')}<p class="photo-cap">장면 ①에서 확인에 쓴 QR을 저장해 왔어요.</p></div>`,
  });
}

function sceneForgery(D, b) {
  const kind = SCENES[1].beats[b].attack || 'birth';
  const a = D.atk[kind];
  const t = hhmm(a.at);
  const left = attackLeft(kind, a.prep);
  let right, w;
  if (b === 0) {
    right = page({
      title: 'QR 스캔', app: VERIFIER, sub: STORE,
      body: `<div class="finder" aria-hidden="true"><p class="finder-cap">손님 화면의 QR을 비춰 주세요</p></div>
        <div class="qr-card">${waiting('스캔을 기다리고 있어요')}</div>`,
    });
    w = wire('right', '손님 폰', '매장 폰', '화면에는 2000.01.01', '눈으로는 진짜와 구별하기 어려워요');
  } else {
    const copy = failureCopy(a.res.out.report) || { head: '확인되지 않았어요', sub: '' };
    right = page({
      title: '확인 결과', app: VERIFIER, sub: STORE,
      body: `${result(false, { label: '확인 실패', title: copy.head, sub: copy.sub })}
        ${group('', [item('판매', { badge: '하지 마세요', tone: 'bad' }), item('영수증', { note: '만들지 않음' })])}`,
      footer: button('다시 스캔', { act: '', fill: 'outline' }),
    });
    const note = {
      birth: ['고친 값: 만 19세 이상 = 예', '발급 당시 해시와 맞지 않아요'],
      forge: ['발급기관 이름은 같아 보여요', '서명한 키가 발급기관 키가 아니에요'],
      replay: ['이미 쓴 요청 번호', `${ellipsis(D.adult.request.nonce, 8, 4)} · 다시 쓸 수 없어요`],
    }[kind];
    w = wire('right', '손님 폰', '매장 폰', note[0], note[1], true);
  }
  return { left, right, wire: w, time: [t, t] };
}

// ---------- 장면 ③ 3개월 뒤 단속 ----------
function receiptItems(payload) {
  return [
    item('결과', { note: payload.result === 'Y' ? '확인됨 (Y)' : '미성년 (N)', tone: 'strong' }),
    item('확인 항목', { note: '만 19세 이상' }),
    item('목적', { note: payload.purpose }),
    item('매장', { note: STORE }),
    item('확인 시각', { note: formatKst(payload.iat * 1000) }),
    item('파기 예정', { note: ymd(payload.exp * 1000) }),
  ];
}

export function auditAt(D) { return D.adult.at + flow.AUDIT_AFTER_DAYS * DAY; }

function sceneAudit(D, b) {
  const rc = decodeJws(D.adult.out.receipt).payload;
  const at = auditAt(D);
  const t = hhmm(at);
  const today = `오늘 ${dayLabel(at)}`;
  let left, right, w;

  if (b === 0) {
    left = page({
      title: '확인 기록', app: VERIFIER, sub: `${STORE} · ${today}`,
      body: group(ymd(D.adult.at), [item('만 19세 이상', { sub: `${hhmm(D.adult.at)} · 영수증 있음`, badge: '확인됨', tone: 'ok' })],
        `영수증은 ${RETENTION_DAYS}일 동안 보관하고 자동으로 지워요.`),
    });
  } else {
    left = page({
      title: '영수증', app: VERIFIER, sub: `${STORE} · ${today}`,
      body: `${group('이 영수증을 제출해요', receiptItems(rc), '이름·생년월일·사진은 들어 있지 않아요.')}`,
      footer: b === 1 ? button('구청에 제출') : button('제출했어요', { act: '', fill: 'outline', disabled: true }),
    });
  }

  if (b < 2) {
    right = page({
      title: '영수증 확인', app: '단속 관리 (데모)', sub: `가상 구청 · ${today}`,
      body: `${group('신고 내용', [item('일자', { note: ymd(D.adult.at) }), item('내용', { note: '미성년자 주류 판매 의심' }), item('매장', { note: STORE })])}
        <div class="qr-card">${waiting('업주의 영수증을 기다리고 있어요')}</div>`,
    });
  } else {
    const ok = D.audit.report.ok;
    const c = Object.fromEntries(D.audit.report.checks.map((x) => [x.id, x.ok]));
    right = page({
      title: '영수증 확인', app: '단속 관리 (데모)', sub: `가상 구청 · ${today}`,
      body: ok
        ? `${result(true, { label: '확인 완료', title: '성인 확인 사실 확인됨', sub: `${formatKst(D.adult.at)} · ${STORE}` })}
           ${group('', [
             item('등록된 매장의 서명', { badge: c.store_sig ? '맞음' : '아님', tone: c.store_sig ? 'ok' : 'bad' }),
             item('개인정보', { note: '없음' }),
             item('보관 기한', { note: `${ymd(rc.exp * 1000)}까지` }),
           ])}`
        : result(false, { label: '확인 실패', title: '영수증을 확인할 수 없어요', sub: D.audit.report.reason }),
    });
  }

  w = b === 0
    ? `<div class="contrast"><p class="contrast-label">지금은</p><p class="contrast-main">휴대폰 화면 확인은<br>인정되지 않아요</p>
      <p class="contrast-sub">포항의 한 주점은 신분증을 확인했지만, 구청이 "사진·휴대폰 화면을 통한 확인은 인정하지 않는다"며 영업정지 처분을 내렸어요.</p></div>`
    : wire('right', '업주 폰', '구청', '영수증 1건', '결과·시각·매장·목적만 있어요');
  return { left, right, wire: w, time: [t, t] };
}

// ---------- 장면 ⑤ 봉인 사본 ----------
export function sealedAt(D, b) { const S = D.sealed; return [S.at, S.at + DAY, S.expiresAt + DAY][b]; }

function sceneSealed(D, b) {
  const S = D.sealed;
  const at = sealedAt(D, b);
  const t = hhmm(at);
  const until = ymd(S.expiresAt);
  const today = `오늘 ${dayLabel(at)}`;
  const left = b === 0
    ? page({
      app: WALLET, title: '내 신분증', body: idCard(P.adult),
      footer: button('사본 보내기', { act: '', fill: 'outline', disabled: true }),
      sheet: `<p class="lead">${esc(AGENCY)}에<br>사본을 보내요</p>
        ${group('', [item('보내요', { note: '이름 · 생년월일', tone: 'strong' }), item('쓰는 곳', { note: '민원 신청 본인 확인' }), item('기한', { note: `${until}까지` })], '기한이 지나면 사본은 무효가 돼요.')}
        <div class="sheet-btn">${button('사본 보내기')}</div>`,
    })
    : page({
      title: '제출 내역', app: WALLET, sub: today,
      body: group('봉인 사본', [item(AGENCY, { sub: `${until.slice(5)}까지 · 민원 신청 본인 확인`, badge: b === 2 ? '만료' : '유효', tone: b === 2 ? '' : 'ok' })]),
    });
  let right;
  if (b === 0) {
    right = page({ title: '사본 확인', app: '민원 접수 (데모)', sub: `${AGENCY} · ${today}`, body: `<div class="qr-card">${waiting('제출된 사본을 기다리고 있어요')}</div>` });
  } else {
    const r = b === 1 ? S.valid : S.expired;
    right = page({
      title: '사본 확인', app: '민원 접수 (데모)', sub: `${AGENCY} · ${today}`,
      body: r.ok
        ? `${result(true, { label: '확인 완료', title: '본인 확인됨', sub: `${P.adult.name} · ${birthDot(P.adult.birthdate)}` })}${group('', [item('유효 기한', { note: `${until}까지` }), item('받는 곳', { note: AGENCY })])}`
        : `${result(false, { label: '무효', title: '기한이 지나 무효예요', sub: `${until}에 만료된 사본이에요.` })}${group('', [item('확인 시점', { note: ymd(at) }), item('기한', { note: `${until}까지`, tone: 'strong' })])}`,
    });
  }
  const w = b === 0
    ? idle('받는 곳·목적·기한이 서명에 묶여요')
    : wire('right', '손님 폰', '기관', `확인 시점 ${ymd(at)}`, b === 1 ? '기한 안이에요' : '기한이 지났어요', b === 2);
  return { left, right, wire: w, time: [t, t] };
}

/** 지금 장면의 두 폰 화면과 가운데 카드 */
export function sceneView(D, { s, b }) {
  return { adult: sceneAdult, forgery: sceneForgery, audit: sceneAudit, sealed: sceneSealed }[SCENES[s].id](D, b);
}
