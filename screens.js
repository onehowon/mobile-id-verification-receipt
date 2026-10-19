// 장면별 폰 화면을 Ionic(iOS 모드) 마크업으로 만든다. 값은 모두 lib/demo-flow.js가 실제로 계산한 결과(D)에서 온다.
// 결과는 iframe(phone.html)으로 보내 그 안에서만 Ionic 스타일이 적용된다.
import { decodeJws } from './lib/jose.js';
import { RETENTION_DAYS } from './lib/receipt.js';
import { PURPOSE_LABELS } from './lib/verifier.js';
import { SCENES, failureCopy, receiptFailureLine, formatKst, ellipsis } from './lib/scenes.js';
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
/** QR 모듈 행렬. 한글이 깨지지 않게 UTF-8 바이트로 넣는다 (카메라 사진도 같은 행렬로 그린다) */
export function makeQr(text) {
  const lib = globalThis.qrcode;
  if (!lib) return null;
  try {
    if (lib.stringToBytesFuncs?.['UTF-8']) lib.stringToBytes = lib.stringToBytesFuncs['UTF-8'];
    const q = lib(0, 'L');
    q.addData(text, 'Byte');
    q.make();
    return q;
  } catch { return null; /* 너무 긴 데이터 */ }
}

export function qr(text, cls = '') {
  const q = makeQr(text);
  const inner = q ? q.createSvgTag({ cellSize: 4, margin: 0, scalable: true }) : '<div class="qr-missing">QR 라이브러리를<br>불러오지 못했어요</div>';
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

const group = (label, items, foot, cls = '') =>
  `${label ? `<p class="group-label">${esc(label)}</p>` : ''}<ion-list inset="true"${cls ? ` class="${cls}"` : ''}>${items.join('')}</ion-list>${foot ? `<p class="group-foot">${esc(foot)}</p>` : ''}`;

/** 한 줄 항목: 왼쪽 제목(+보조), 오른쪽 값·배지 */
function item(main, { sub, note, badge, tone, mark, cls = '' } = {}) {
  const end = badge
    ? `<ion-badge slot="end" class="${tone === 'ok' ? 'soft-ok' : tone === 'bad' ? 'soft-bad' : 'soft'}">${esc(badge)}</ion-badge>`
    : note ? `<ion-note slot="end" class="${tone === 'strong' ? 'strong' : ''}">${esc(note)}</ion-note>` : '';
  return `<ion-item lines="full" class="${cls}"><ion-label>${sub ? `<h3>${esc(main)}</h3><p>${esc(sub)}</p>` : `<h3>${esc(main)}</h3>`}</ion-label>${end}${mark || ''}</ion-item>`;
}

function result(ok, { label, title, sub, compact = false }) {
  return `<div class="result ${ok ? 'is-ok' : 'is-bad'}${compact ? ' is-compact' : ''}" role="status">${ok ? ICON_OK : ICON_BAD}
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

// ---------- 장면 ① 연령 확인 ----------
const ICON_SCAN_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="currentColor"/><path d="M7 12.5l3.2 3.2L17 9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** 카메라 인식 상태: 사진이 없으면 실패, 지금 요청을 읽었으면 그 결과, 아니면 찾는 중 */
export function scanState(D) {
  if (!D.scanFrame?.url) return 'fail';
  if (D.scan?.nonce === D.req1.nonce) return D.scan.ok ? 'ok' : 'fail';
  return 'scanning';
}

/** 손님 앱 카메라 화면. data-key가 같으면 phone.js가 다시 그리지 않고 상태만 바꾼다(스캔 라인이 끊기지 않게) */
function cameraPage(D) {
  const state = scanState(D);
  const status = state === 'ok'
    ? `<span class="cam-pill">${ICON_SCAN_OK}인식했어요</span>`
    : state === 'fail' ? `<span class="cam-pill">${esc(D.scan?.reason || 'QR을 읽지 못했어요')}</span>` : '';
  return `<div class="ion-page cam-page" data-statusbar="light">
  <div class="cam" data-key="${esc(D.req1.nonce)}" data-state="${state}">
    <div class="cam-top"><p class="cam-title">QR 촬영</p><p class="cam-hint">매장 화면의 QR을 <br>네모 안에 맞춰 주세요</p></div>
    <div class="cam-view">
      ${D.scanFrame?.url ? `<img class="cam-feed" src="${D.scanFrame.url}" alt="카메라에 비친 매장 폰 화면의 QR">` : ''}
      <div class="cam-guide" aria-hidden="true"><i></i><i></i><i></i><i></i><span class="cam-line"></span></div>
    </div>
    <p class="cam-status" role="status">${status}</p>
    <div class="cam-bar">
      <button type="button" class="cam-btn" aria-label="손전등"><ion-icon name="flashlight-outline"></ion-icon></button>
      <button type="button" class="cam-btn" aria-label="닫기"><ion-icon name="close-outline"></ion-icon></button>
    </div>
  </div>
</div>`;
}

function sceneAdult(D, b) {
  const now = D.adult?.at || D.req1At || Date.now();
  const t = hhmm(now);
  let left, right, w;

  if (b === 1) {
    left = cameraPage(D);
  } else if (b < 3) {
    left = page({
      title: '내 신분증', app: WALLET,
      body: `${idCard(P.adult)}${group('제출 내역', [item('아직 제출한 내역이 없어요', {})])}`,
      footer: button('QR 스캔', { fill: 'outline', disabled: b === 2 }),
      sheet: b === 2 ? `<p class="lead">${esc(STORE)}에<br>'청소년 아님(연 나이 기준)' 여부만 보내요</p>
        ${group('보내는 정보', [item('청소년이 아닌지', { sub: '예 / 아니오 하나 · 1회용 증명', mark: CHECK })])}
        ${group('보내지 않는 정보', [item('이름 · 생년월일 · 출생연도', { cls: 'give-no' })], `${PURPOSE_LABELS[D.req1.purpose] || D.req1.purpose} · 이 판매 1건에만 쓰여요`)}
        <div class="sheet-btn">${button('보내기')}</div>` : '',
    });
  } else {
    left = page({
      title: '제출 내역', app: WALLET,
      body: `${group(ymd(D.adult.at), [item(STORE, { sub: `청소년 아님 여부 · ${hhmm(D.adult.at)}`, badge: '보냄', tone: 'ok' })])}
        ${group('보낸 정보', [item('청소년이 아닌지', { note: '예', tone: 'strong' }), item('이름 · 생년월일', { note: '안 보냄' })], `1회용 증명을 썼어요. 남은 증명 ${D.ctx.adult.wallet.remaining}장.`)}`,
    });
  }

  if (b === 0) {
    right = page({
      title: '확인 요청', app: VERIFIER, sub: STORE,
      body: `<p class="lead">어떤 확인이 필요하세요?</p>${group('', [
        item('연령 확인', { sub: '청소년이 아닌지만 받아요 (연 나이)', mark: CHECK }),
        item('본인 확인', { sub: '이 데모에서는 쓰지 않아요', cls: 'give-no' }),
      ])}`,
      footer: button('연령 확인'),
    });
    w = idle();
  } else if (b < 3) {
    // 손님이 찍는 동안과 동의하는 동안 매장 폰은 같은 화면 그대로(손님 응답 대기)
    right = page({
      title: 'QR 보여 주기', app: VERIFIER, sub: STORE,
      body: `<div class="qr-card">${qr(JSON.stringify(D.req1))}${waiting('손님 응답을 기다리고 있어요')}</div>
        ${group('', [item('확인 항목', { note: '청소년 아님' }), item('판매 번호', { note: D.req1Pos }), item('유효 시간', { note: '2분 · 1회용' })])}`,
    });
    w = b === 1
      ? wire('left', '매장 폰', '손님 폰', '요청 QR', '청소년 아님 여부 · 1회용 번호 · 판매 번호 해시')
      : wire('left', '매장 폰', '손님 폰', '요청 QR을 읽었어요', '손님 폰은 아직 아무것도 보내지 않았어요');
  } else {
    const ok = D.adult.out.report.ok && D.adult.out.result === 'Y';
    right = page({
      title: '확인 결과', app: VERIFIER, sub: STORE,
      body: ok
        ? `${result(true, { label: '확인 완료', title: '청소년 아님 확인됨', sub: '이름과 생년월일은 받지 않았어요.', compact: true })}
           ${group('', [item('영수증', { badge: '저장됨', tone: 'ok' }), item('공통기반 원장', { badge: '기록됨', tone: 'ok' }), item('판매 번호', { note: D.adult.posTxId })], '', 'dense')}`
        : result(false, { label: '확인 실패', ...failureCopy(D.adult.out.report) }),
      footer: button('확인'),
    });
    w = wire('right', '손님 폰', '매장 폰', '청소년 아님 = 예', '1회용 증명 + 손님 서명(이 매장·이 판매) · 이름·생년월일 없음');
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
      birth: ['고친 값: 청소년 아님 = 예', '발급 당시 해시와 맞지 않아요'],
      forge: ['발급기관 이름은 같아 보여요', '서명한 키가 발급기관 키가 아니에요'],
      replay: ['이미 쓴 요청 번호', `${ellipsis(D.adult.request.nonce, 8, 4)} · 다시 쓸 수 없어요`],
    }[kind];
    w = wire('right', '손님 폰', '매장 폰', note[0], note[1], true);
  }
  return { left, right, wire: w, time: [t, t] };
}

// ---------- 장면 ③ 3개월 뒤 단속 ----------
function receiptItems(payload, posTxId) {
  return [
    item('결과', { note: payload.result === 'Y' ? '청소년 아님 (Y)' : '청소년 (N)', tone: 'strong' }),
    item('목적', { note: PURPOSE_LABELS[payload.purpose] || payload.purpose }),
    item('판매 번호', { note: posTxId }),
    item('확인 시각', { note: formatKst(payload.iat * 1000) }),
    item('손님 서명', { note: '1회용 증명' }),
    item('파기 예정', { note: ymd(payload.exp * 1000) }),
  ];
}

export function auditAt(D) { return D.adult.at + flow.AUDIT_AFTER_DAYS * DAY; }

const mark = (ok) => ({ badge: ok ? '맞음' : '아님', tone: ok ? 'ok' : 'bad' });

function sceneAudit(D, b) {
  const rc = decodeJws(D.adult.out.receipt).payload;
  const pos = D.adult.posTxId;
  const at = auditAt(D);
  const t = hhmm(at);
  const today = `오늘 ${dayLabel(at)}`;
  const OFFICE = { title: '영수증 확인', app: '단속 관리 (데모)', sub: `가상 구청 · ${today}` };
  let left, right, w;

  if (b === 0) {
    left = page({
      title: '확인 기록', app: VERIFIER, sub: `${STORE} · ${today}`,
      body: group(ymd(D.adult.at), [item('청소년 아님', { sub: `${hhmm(D.adult.at)} · ${pos}`, badge: '확인됨', tone: 'ok' })],
        `판매마다 영수증이 있어요. ${RETENTION_DAYS}일 동안 보관하고 자동으로 지워요.`),
    });
  } else if (b < 3) {
    left = page({
      title: '영수증', app: VERIFIER, sub: `${STORE} · ${today}`,
      body: `${group('이 영수증을 제출해요', receiptItems(rc, pos), '이름·생년월일·사진은 들어 있지 않아요.')}`,
      footer: b === 1 ? button('구청에 제출') : button('제출했어요', { act: '', fill: 'outline', disabled: true }),
    });
  } else {
    left = page({
      title: '영수증 만들기', app: '업주가 고친 앱', sub: `${STORE} · 매장 키 사용`,
      body: `<span class="tagline">업주가 직접 만든 가짜 영수증</span>${group('', [
        item('직접 만든 영수증', { sub: `${pos} · 결과 Y · 매장 키로 서명` }),
        item('고친 영수증', { sub: `${D.owner.flip.posTxId} · N을 Y로 고쳐 다시 서명` }),
      ], '원장에도 올렸어요. 매장 서명은 진짜예요.')}`,
      footer: button('구청에 제출', { act: '', fill: 'outline', disabled: true }),
    });
  }

  if (b < 2) {
    right = page({
      ...OFFICE,
      body: `${group('신고 내용', [item('일자', { note: ymd(D.adult.at) }), item('판매 번호', { note: pos }), item('내용', { note: '미성년자 주류 판매 의심' })])}
        <div class="qr-card">${waiting('업주의 영수증을 기다리고 있어요')}</div>`,
    });
  } else if (b === 2) {
    const R = D.audit.report;
    const c = Object.fromEntries(R.checks.map((x) => [x.id, x.ok]));
    const all = (...ids) => ids.every((id) => c[id]);
    right = page({
      ...OFFICE,
      body: R.ok
        ? `${result(true, { label: '확인 완료', title: '연령 확인 사실 확인됨', sub: `${formatKst(D.adult.at)} · ${pos}`, compact: true })}
           ${group('', [
             item('발급기관 서명', mark(all('issuer_sig', 'validity_at'))),
             item('손님 서명', mark(all('holder_binding', 'result'))),
             item('이 매장·이 시각·이 거래', mark(all('audience', 'nonce', 'tx_binding', 'time'))),
             item('매장 서명', mark(all('store_cert', 'store_sig'))),
             item('원장 기록', { badge: c.anchor ? '있음' : '없음', tone: c.anchor ? 'ok' : 'bad' }),
             item('개인정보', { note: c.format && c.disclosure ? '없음' : '있음', tone: 'strong' }),
           ], '', 'dense')}`
        : result(false, { label: '확인 실패', title: '영수증을 확인할 수 없어요', sub: receiptFailureLine(R) }),
    });
  } else {
    const O = D.owner;
    const bad = [O.fakeIssuer.report, O.flip.report];
    const rejected = bad.every((r) => !r.ok);
    right = page({
      ...OFFICE,
      body: `${result(!rejected, rejected
        ? { label: '확인 실패', title: '업주가 만든 영수증은 통과 못 해요', sub: '손님·발급기관 서명은 업주가 만들 수 없어요.', compact: true }
        : { label: '확인 완료', title: '가짜 영수증이 통과했어요', sub: '', compact: true })}
        ${group('', [
          item('직접 만든 영수증', { sub: receiptFailureLine(O.fakeIssuer.report) || '통과', badge: O.fakeIssuer.report.ok ? '통과' : '거부', tone: O.fakeIssuer.report.ok ? '' : 'bad' }),
          item('고친 영수증 (N→Y)', { sub: receiptFailureLine(O.flip.report) || '통과', badge: O.flip.report.ok ? '통과' : '거부', tone: O.flip.report.ok ? '' : 'bad' }),
        ])}`,
    });
  }

  if (b === 0) {
    w = `<div class="contrast"><p class="contrast-label">지금은</p><p class="contrast-main">직원이 눈으로는 공식 앱과 위조 앱을 구별하기 어렵고, 확인했다는 기록이 남지 않아요</p>
      <p class="contrast-sub">포항의 한 호프집은 손님 휴대폰에 저장된 신분증 사진만 보고 팔았다가 영업정지를 받았어요. 구청은 실물이나 공인된 인증서·앱이 아닌 사진 확인은 인정하지 않았어요(경북매일, 2024.4.8).</p></div>`;
  } else if (b < 3) {
    w = wire('right', '업주 폰', '구청', '영수증 1건', `${pos} · 손님 1회용 서명 + 매장 서명 + 원장 확인`);
  } else {
    w = wire('right', '업주 폰', '구청', '가짜 영수증 2건', '매장 서명은 맞지만 발급기관 판정과 손님 서명이 맞지 않아요', true);
  }
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
