// 화면만 담당한다. 서명·검증·영수증은 lib/demo-flow.js가 실제로 수행하고, 여기서는 그 결과를 그린다.
import { decodeJws } from './lib/jose.js';
import { ISSUER } from './lib/demo-keys.js';
import { CHECKS, CLAIM_LABELS, parseSdJwt, decodeDisclosure } from './lib/sdjwt.js';
import { RECEIPT_CHECKS, RECEIPT_FIELDS, RETENTION_DAYS } from './lib/receipt.js';
import { STEPS_ASIS, STEPS_TOBE, toCsv, summarize } from './lib/measure.js';
import { DEFAULT_PURPOSE } from './lib/verifier.js';
import { SCENES, BEAT_COUNT, nextPos, prevPos, beatIndex, posFromQuery, failureCopy, formatKst, formatMs, ellipsis } from './lib/scenes.js';
import * as flow from './lib/demo-flow.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DAY = flow.DAY_MS;
const NONCE_SAFE_MS = 90000; // 요청 유효 120초보다 먼저 새로 만든다 (발표 중 멈춰 있어도 실패하지 않게)
const ATTACK_BEAT = { birth: 1, forge: 2, replay: 3 };
const ATTACK_LABEL = { birth: '생년 변조', forge: '서명 위조', replay: '재사용' };

const st = { pos: { s: 0, b: 0 }, side: 'right', playing: false, timer: 0, raf: 0, started: 0, remaining: 0, beatMs: 0, token: 0, drawer: false };
let D = null;

// ---------- 데이터: 장면에 필요한 만큼만, 실제로 계산 ----------
async function reset() {
  D = { ctx: await flow.setupDemo(), atk: {} };
}

function ensureReq1() {
  if (!D.req1 || Date.now() - D.req1At > NONCE_SAFE_MS) {
    D.req1 = flow.newRequest(D.ctx);
    D.req1At = Date.now();
  }
}
async function ensureAdult() {
  if (D.adult) return;
  ensureReq1();
  D.adult = await flow.runAdultCheck(D.ctx, { request: D.req1 });
}
async function ensureAttack(kind, verify) {
  if (kind === 'replay') await ensureAdult();
  let a = D.atk[kind];
  if (!a || (!a.res && Date.now() - a.at > NONCE_SAFE_MS)) {
    a = D.atk[kind] = { prep: await flow.prepareAttack(D.ctx, kind, { usedVp: D.adult?.vp }), at: Date.now() };
  }
  if (verify && !a.res) a.res = await flow.verifyAttack(D.ctx, a.prep);
}

async function prepare({ s, b }) {
  const id = SCENES[s].id;
  if (id === 'adult') {
    if (b >= 1) ensureReq1();
    if (b >= 2) await ensureAdult();
  } else if (id === 'forgery') {
    const kind = SCENES[s].beats[b].attack || 'birth';
    await ensureAttack(kind, b > 0);
  } else if (id === 'audit') {
    await ensureAdult();
    if (b >= 2 && !D.audit) D.audit = await flow.runAudit(D.adult.out.receipt, { issuedAt: D.adult.at });
  } else if (id === 'compare') {
    await ensureAdult();
    if (!D.bench) D.bench = await flow.runBenchmark(D.ctx, 30);
  } else if (id === 'sealed') {
    if (!D.sealed) D.sealed = await flow.runSealed(D.ctx);
  }
}

// ---------- 작은 조각 ----------
const ICON_OK = '<svg class="result-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="currentColor"/><path d="M19 33l9 9 17-19" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BAD = '<svg class="result-icon" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="currentColor"/><path d="M22 22l20 20M42 22L22 42" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>';
const hhmm = (ms) => formatKst(ms).slice(11);
const ymd = (ms) => formatKst(ms, { time: false });
const birthDot = (s) => s.replaceAll('-', '.');

function qr(text, cls = '') {
  let inner = '<div class="qr-missing">QR 라이브러리를<br>불러오지 못했어요</div>';
  if (window.qrcode) {
    try {
      const q = window.qrcode(0, 'L');
      q.addData(text);
      q.make();
      inner = q.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    } catch { /* 너무 긴 데이터: 안내 문구 유지 */ }
  }
  return `<div class="qr ${cls}" role="img" aria-label="QR 코드">${inner}</div>`;
}

function phone({ app, sub, time, body, cta, sheet, gray, center }) {
  return `<div class="scr${gray ? ' on-gray' : ''}">
    <div class="sbar" aria-hidden="true"><span>${esc(time)}</span><span class="sbar-bat"></span></div>
    <div class="appbar"><p class="appbar-title">${esc(app)}</p>${sub ? `<p class="appbar-sub">${esc(sub)}</p>` : ''}</div>
    <div class="scr-body${center ? ' center' : ''}">${body}</div>
    ${cta ? `<div class="scr-cta">${cta}</div>` : ''}
    ${sheet ? `<div class="dim" aria-hidden="true"></div><div class="sheet" role="dialog" aria-modal="false" aria-label="보낼 정보 확인">${sheet}</div>` : ''}
  </div>`;
}
const btn = (label, { act = 'next', kind = 'primary', disabled = false } = {}) =>
  `<button type="button" class="krds-btn large ${kind}"${act ? ` data-act="${act}"` : ''}${disabled ? ' disabled' : ''}>${esc(label)}</button>`;

function result(ok, { label, title, sub }) {
  return `<div class="result ${ok ? 'is-ok' : 'is-bad'}" role="status">${ok ? ICON_OK : ICON_BAD}
    <p class="result-label">${esc(label)}</p><p class="result-title">${esc(title)}</p>${sub ? `<p class="result-sub">${esc(sub)}</p>` : ''}</div>`;
}

function idCard(person, { birth, edited, kicker = '모바일 신분증 · 가상' } = {}) {
  return `<div class="card"><p class="idcard-kicker">${esc(kicker)}</p><p class="idcard-name">${esc(person.name)}</p>
    <dl class="rows"><div><dt>생년월일</dt><dd${edited ? ' class="edited"' : ''}>${esc(birth || birthDot(person.birthdate))}</dd></div><div><dt>발급</dt><dd>가상 발급기관</dd></div></dl></div>`;
}

function wire(dir, from, to, main, sub, bad = false) {
  return `<div class="wire-item" data-dir="${dir}">
    <p class="wire-dir">${dir === 'left' ? `<span>${esc(to)}</span><span class="wire-arrow"></span><span>${esc(from)}</span>` : `<span>${esc(from)}</span><span class="wire-arrow"></span><span>${esc(to)}</span>`}</p>
    <div class="wire-box${bad ? ' is-bad' : ''}"><p class="wire-main">${esc(main)}</p>${sub ? `<p class="wire-sub">${esc(sub)}</p>` : ''}</div></div>`;
}
const idle = (t = '아직 주고받은 정보가 없어요') => `<p class="wire-idle">${esc(t)}</p>`;

// ---------- 장면별 화면 ----------
const WALLET = '모바일 신분증 (데모)';
const VERIFIER = '검증앱 (데모)';
const P = flow.PEOPLE;

function walletHome(now, history = []) {
  const list = history.length
    ? `<ul class="list">${history.map((h) => `<li class="list-item"><div><p class="list-main">${esc(h.to)}</p><p class="list-sub">${esc(h.what)} · ${esc(h.when)}</p></div><span class="list-state is-plain">${esc(h.state)}</span></li>`).join('')}</ul>`
    : '<p class="empty">아직 제출한 내역이 없어요</p>';
  return { idCard: idCard(P.adult), list };
}

function sceneAdult(b) {
  const now = D.adult?.at || Date.now();
  const time = hhmm(now);
  const w = walletHome(now);
  const store = flow.STORE.name;
  let left, right, wireHtml;

  if (b < 2) {
    left = phone({
      app: WALLET, time, gray: true,
      body: `${w.idCard}<p class="list-head">제출 내역</p>${w.list}`,
      cta: btn('QR 스캔', { act: '', kind: 'secondary', disabled: true }),
      sheet: b === 1 ? `<span class="sheet-grip" aria-hidden="true"></span>
        <p class="sheet-title">${esc(store)}에 '만 19세 이상' 여부만 보내요</p>
        <dl class="give"><div><dt>보내요</dt><dd>만 19세 이상인지</dd></div><div class="is-no"><dt>안 보내요</dt><dd>이름 · 생년월일 · 주소</dd></div></dl>
        <p class="scr-caption">목적: ${esc(DEFAULT_PURPOSE)} · 한 번만 쓰는 요청이에요</p>
        ${btn('보내기')}` : '',
    });
  } else {
    const h = [{ to: store, what: '만 19세 이상 여부', when: hhmm(D.adult.at), state: '보냄' }];
    left = phone({
      app: WALLET, sub: '제출 내역', time, gray: true,
      body: `<p class="scr-title">${esc(store)}에 보냈어요</p><p class="scr-caption">보낸 정보는 만 19세 이상 여부 하나예요.</p>
        <p class="list-head">제출 내역 1건</p>${walletHome(now, h).list}`,
    });
  }

  if (b === 0) {
    right = phone({
      app: VERIFIER, sub: store, time,
      body: `<p class="scr-title">어떤 확인이<br>필요하세요?</p>
        <div class="option"><p class="option-title">성인 확인</p><p class="option-sub">만 19세 이상인지만 받아요</p></div>
        <div class="option is-off"><p class="option-title">본인 확인</p><p class="option-sub">이 데모에서는 쓰지 않아요</p></div>`,
      cta: btn('성인 확인'),
    });
    wireHtml = idle();
  } else if (b === 1) {
    right = phone({
      app: VERIFIER, sub: store, time,
      body: `<p class="scr-title">손님에게 이 QR을<br>보여 주세요</p>${qr(JSON.stringify(D.req1))}
        <p class="waiting">손님 응답을 기다리고 있어요</p><p class="scr-caption" style="text-align:center">한 번만 쓸 수 있고 2분 뒤 사라져요</p>`,
    });
    wireHtml = wire('left', '매장 폰', '손님 폰', '요청: 만 19세 이상 여부', '1회용 번호가 들어 있어요');
  } else {
    const ok = D.adult.out.report.ok && D.adult.out.result === 'Y';
    right = phone({
      app: VERIFIER, sub: store, time,
      body: ok
        ? `${result(true, { label: '확인 완료', title: '만 19세 이상 확인됨', sub: '이름과 생년월일은 받지 않았어요.' })}
           <div class="fact"><b>영수증 저장됨</b><span>개인정보 없음</span></div>`
        : result(false, { label: '확인 실패', ...failureCopy(D.adult.out.report) }),
      cta: btn('확인', { act: 'next' }),
    });
    wireHtml = wire('right', '손님 폰', '매장 폰', '만 19세 이상 = 예', '이름·생년월일은 보내지 않았어요');
  }
  return { left, right, wire: wireHtml };
}

function attackLeft(kind, prep, time) {
  if (kind === 'birth') {
    return phone({
      app: WALLET, time, gray: true,
      body: `<span class="tag">캡처 화면 · 생년월일을 고침</span>${idCard(P.minor, { birth: '2000.01.01', edited: true })}
        <p class="anno">원래 생년월일은 ${esc(birthDot(P.minor.birthdate))}이에요.</p>${qr(prep.vp, 'small')}`,
    });
  }
  if (kind === 'forge') {
    return phone({
      app: WALLET, time, gray: true,
      body: `<span class="tag">위조 앱 · 스스로 서명</span>${idCard({ name: '홍길동' }, { birth: '1990.01.01' })}
        <p class="anno">겉모습은 진짜 앱과 똑같아요.</p>${qr(prep.vp, 'small')}`,
    });
  }
  return phone({
    app: '사진 앨범', time, gray: true,
    body: `<span class="tag">다른 사람이 쓴 QR 캡처</span><p class="scr-text">장면 ①에서 이미 확인에 쓴 QR을 저장해 왔어요.</p>${qr(prep.vp, 'small')}`,
  });
}

function sceneForgery(b) {
  const kind = SCENES[1].beats[b].attack || 'birth';
  const a = D.atk[kind];
  const time = hhmm(a.at);
  const left = attackLeft(kind, a.prep, time);
  let right, wireHtml;
  if (b === 0) {
    right = phone({
      app: VERIFIER, sub: flow.STORE.name, time,
      body: `<p class="scr-title">손님 화면의 QR을<br>스캔해 주세요</p><div class="finder" aria-hidden="true"></div><p class="waiting">스캔을 기다리고 있어요</p>`,
    });
    wireHtml = wire('right', '손님 폰', '매장 폰', '화면에는 2000.01.01', '눈으로는 진짜와 구별하기 어려워요');
  } else {
    const r = a.res.out.report;
    const copy = failureCopy(r) || { head: '확인되지 않았어요', sub: '' };
    right = phone({
      app: VERIFIER, sub: flow.STORE.name, time,
      body: `${result(false, { label: '확인 실패', title: copy.head, sub: copy.sub })}
        <div class="fact"><b>판매하지 마세요</b><span>영수증 없음</span></div>`,
    });
    const note = {
      birth: ['고친 값: 만 19세 이상 = 예', '발급 당시 해시와 맞지 않아요'],
      forge: ['발급기관 이름은 같아 보여요', '서명한 키가 발급기관 키가 아니에요'],
      replay: ['이미 쓴 요청 번호', `${ellipsis(D.adult.request.nonce, 8, 4)} · 다시 쓸 수 없어요`],
    }[kind];
    wireHtml = wire('right', '손님 폰', '매장 폰', note[0], note[1], true);
  }
  return { left, right, wire: wireHtml };
}

function receiptRows(payload) {
  return `<dl class="rows">
    <div><dt>결과</dt><dd>${payload.result === 'Y' ? '확인됨 (Y)' : '미성년 (N)'}</dd></div>
    <div><dt>확인 항목</dt><dd>만 19세 이상</dd></div>
    <div><dt>목적</dt><dd>${esc(payload.purpose)}</dd></div>
    <div><dt>매장</dt><dd>${esc(flow.STORE.name)}</dd></div>
    <div><dt>확인 시각</dt><dd>${esc(formatKst(payload.iat * 1000))}</dd></div>
    <div><dt>파기 예정</dt><dd>${esc(ymd(payload.exp * 1000))}</dd></div></dl>`;
}

function sceneAudit(b) {
  const rc = decodeJws(D.adult.out.receipt).payload;
  const auditAt = D.adult.at + flow.AUDIT_AFTER_DAYS * DAY;
  const time = hhmm(auditAt);
  const issued = formatKst(D.adult.at);
  let left, right, wireHtml;

  if (b === 0) {
    left = phone({
      app: VERIFIER, sub: '확인 기록', time, gray: true,
      body: `<p class="list-head">${esc(ymd(D.adult.at))}</p>
        <ul class="list"><li class="list-item"><div><p class="list-main">만 19세 이상</p><p class="list-sub">${esc(hhmm(D.adult.at))} · 영수증 있음</p></div><span class="list-state">확인됨</span></li></ul>
        <p class="scr-caption">영수증은 ${RETENTION_DAYS}일 동안 보관하고 자동으로 지워요.</p>`,
    });
  } else {
    left = phone({
      app: VERIFIER, sub: '영수증', time,
      body: `<p class="scr-title">이 영수증을<br>제출할게요</p><div class="card">${receiptRows(rc)}</div>
        <p class="scr-caption">이름·생년월일·사진은 들어 있지 않아요.</p>`,
      cta: b === 1 ? btn('구청에 제출') : btn('제출했어요', { act: '', kind: 'secondary', disabled: true }),
    });
  }

  if (b < 2) {
    right = phone({
      app: '단속 확인 (데모)', sub: '가상 구청', time,
      body: `<p class="scr-title">업주에게 영수증을<br>요청해 주세요</p>
        <p class="scr-text">신고 내용: ${esc(ymd(D.adult.at))} 미성년자 주류 판매 의심</p>
        <p class="waiting">영수증을 기다리고 있어요</p>`,
    });
  } else {
    const ok = D.audit.report.ok;
    const c = Object.fromEntries(D.audit.report.checks.map((x) => [x.id, x.ok]));
    right = phone({
      app: '단속 확인 (데모)', sub: '가상 구청', time,
      body: ok
        ? `${result(true, { label: '확인 완료', title: '성인 확인 사실 확인됨', sub: `${issued} · ${flow.STORE.name}` })}
           <ul class="mini-checks">
             <li><span>등록된 매장의 서명</span><span class="v">${c.store_sig ? '맞음' : '아님'}</span></li>
             <li><span>개인정보</span><span class="v">없음</span></li>
             <li><span>보관 기한</span><span class="v">${esc(ymd(rc.exp * 1000))}까지</span></li></ul>
           <p class="scr-caption" style="text-align:center">이 영수증에는 개인정보가 없어요.</p>`
        : result(false, { label: '확인 실패', title: '영수증을 확인할 수 없어요', sub: D.audit.report.reason }),
    });
  }

  if (b === 0) {
    wireHtml = `<div class="contrast"><p class="contrast-label">지금은</p><p class="contrast-main">휴대폰 화면 확인은<br>인정되지 않아요</p>
      <p class="contrast-sub">포항의 한 주점은 신분증을 확인했지만, 구청이 "사진·휴대폰 화면을 통한 확인은 인정하지 않는다"며 영업정지 처분을 내렸어요.</p></div>`;
  } else {
    wireHtml = wire('right', '업주 폰', '구청', '영수증 1건', '결과·시각·매장·목적만 있어요');
  }
  return { left, right, wire: wireHtml };
}

function sceneSealed(b) {
  const S = D.sealed;
  const at = [S.at, S.at + DAY, S.expiresAt + DAY][b];
  const time = hhmm(at);
  const until = ymd(S.expiresAt);
  const agency = flow.AGENCY.name;
  const left = b === 0
    ? phone({
      app: WALLET, time, gray: true,
      body: idCard(P.adult),
      sheet: `<span class="sheet-grip" aria-hidden="true"></span><p class="sheet-title">${esc(agency)}에 사본을 보내요</p>
        <dl class="give"><div><dt>보내요</dt><dd>이름 · 생년월일</dd></div><div><dt>쓰는 곳</dt><dd>민원 신청 본인 확인</dd></div><div><dt>기한</dt><dd>${esc(until)}까지</dd></div></dl>
        <p class="scr-caption">기한이 지나면 사본은 무효가 돼요.</p>${btn('사본 보내기')}`,
    })
    : phone({
      app: WALLET, sub: '제출 내역', time, gray: true,
      body: `<p class="list-head">제출 내역</p><ul class="list"><li class="list-item"><div><p class="list-main">${esc(agency)}</p><p class="list-sub">${esc(until.slice(5))}까지 · 봉인 사본</p></div><span class="list-state${b === 2 ? ' is-plain' : ''}">${b === 2 ? '만료' : '유효'}</span></li></ul>`,
    });
  let right;
  if (b === 0) {
    right = phone({ app: '민원 접수 (데모)', sub: agency, time, body: '<p class="scr-title">제출된 사본을<br>기다리고 있어요</p><p class="waiting">대기 중</p>' });
  } else {
    const r = b === 1 ? S.valid : S.expired;
    right = phone({
      app: '민원 접수 (데모)', sub: agency, time,
      body: r.ok
        ? `${result(true, { label: '확인 완료', title: '본인 확인됨', sub: `${P.adult.name} · ${birthDot(P.adult.birthdate)}` })}<div class="fact"><b>유효 기한</b><span>${esc(until)}까지</span></div>`
        : `${result(false, { label: '무효', title: '기한이 지나 무효예요', sub: `${until}에 만료된 사본이에요.` })}<div class="fact"><b>확인 시점</b><span>${esc(ymd(at))}</span></div>`,
    });
  }
  const wireHtml = b === 0
    ? idle('받는 곳·목적·기한이 서명에 묶여요')
    : wire('right', '손님 폰', '기관', `확인 시점 ${ymd(at)}`, b === 1 ? '기한 안이에요' : '기한이 지났어요', b === 2);
  return { left, right, wire: wireHtml };
}

function compareHtml() {
  const B = D.bench;
  const measured = D.ctx.measures.filter((m) => m.scenario === 'benchmark');
  const tot = summarize(measured.map((m) => m.total_ms));
  return `<div class="cmp" role="table" aria-label="지금과 바뀐 뒤">
    <div class="cmp-h" role="columnheader"></div><div class="cmp-h" role="columnheader">지금</div><div class="cmp-h is-new" role="columnheader">바뀐 뒤</div>
    <div class="cmp-row" role="rowheader">확인 단계</div>
    <div><p class="cmp-big">${STEPS_ASIS.length}단계</p><ol class="cmp-steps">${STEPS_ASIS.map((x) => `<li>${esc(x.step)}</li>`).join('')}</ol></div>
    <div class="cmp-new"><p class="cmp-big">${STEPS_TOBE.length}단계</p><ol class="cmp-steps">${STEPS_TOBE.map((x) => `<li>${esc(x.step)}</li>`).join('')}</ol></div>
    <div class="cmp-row" role="rowheader">검증 시간</div>
    <div><p class="cmp-big">잴 수 없어요</p><p class="cmp-sub">직원이 화면을 눈으로 보고 판단해요.</p></div>
    <div class="cmp-new"><p class="cmp-big">${esc(formatMs(tot ? tot.median : B.median))}</p><p class="cmp-sub">중앙값 · p95 ${esc(formatMs(tot ? tot.p95 : B.p95))} · 이 기기에서 ${tot ? tot.n : B.n}회 실제 측정 (서명 검증 + 영수증 서명)</p></div>
    <div class="cmp-row" role="rowheader">매장이 보는 정보</div>
    <div><p class="cmp-big">생년월일 전체</p><p class="cmp-sub">이름·사진·주소까지 화면으로 봐요.</p></div>
    <div class="cmp-new"><p class="cmp-big">예 / 아니오</p><p class="cmp-sub">만 19세 이상인지 하나만 받아요.</p></div>
    <div class="cmp-row" role="rowheader">분쟁 때 입증</div>
    <div><p class="cmp-big">CCTV 영상</p><p class="cmp-sub">찾아서 내야 하고, 화면 확인은 인정되지 않을 수 있어요(포항 사례).</p></div>
    <div class="cmp-new"><p class="cmp-big">영수증 1건</p><p class="cmp-sub">매장 서명 · 개인정보 없음 · ${RETENTION_DAYS}일 보관</p></div>
  </div>
  <div class="cmp-actions"><p class="scr-caption">QR 인식과 사람이 보는 시간은 빼고, 검증기 계산 시간만 쟀어요.</p>
    <button type="button" class="krds-btn medium tertiary" data-act="rebench">다시 측정 (30회)</button>
    <button type="button" class="krds-btn medium secondary" data-act="csv">CSV 내보내기</button></div>`;
}

// ---------- 기술 상세 ----------
const sec = (title, html) => `<section class="d-sec"><h3 class="d-title">${esc(title)}</h3>${html}</section>`;
const kv = (rows) => `<dl class="d-kv">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
const code = (v) => `<pre class="d-code">${esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre>`;
function checks(report, labels) {
  const by = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  const ids = [...Object.keys(labels), ...report.checks.map((c) => c.id).filter((id) => !(id in labels))];
  return `<ul class="d-checks">${ids.map((id) => {
    const c = by[id];
    const cls = c ? (c.ok ? 'ok' : 'bad') : 'skip';
    const m = c ? (c.ok ? '통과' : '실패') : '안 함';
    return `<li class="${cls}"><span class="m">${m}</span><span>${esc(c ? c.label : labels[id])}${c && c.detail ? `<span class="detail">${esc(c.detail)}</span>` : ''}</span></li>`;
  }).join('')}</ul>`;
}
const STORE_CHECKS = Object.fromEntries(['format', 'issuer_sig', 'validity', 'disclosure', 'holder_binding', 'audience', 'nonce', 'freshness', 'claim'].map((k) => [k, CHECKS[k]]));

function vpSections(vp) {
  const { issuerJwt, disclosures, kbJwt } = parseSdJwt(vp);
  const iss = decodeJws(issuerJwt);
  const kb = kbJwt ? decodeJws(kbJwt).payload : null;
  return sec('제시물 원문 (앞부분)', code(ellipsis(vp, 120, 40)) + `<p class="d-note">전체 ${vp.length}자 · 발급기관 JWT ~ 공개 항목 ~ 기기 서명(KB-JWT)</p>`)
    + sec('공개된 항목', disclosures.length ? kv(disclosures.map((d) => { const x = decodeDisclosure(d); return [CLAIM_LABELS[x.name] || x.name, `${JSON.stringify(x.value)}  (salt ${ellipsis(x.salt, 6, 4)})`]; })) : '<p class="d-note">없음</p>')
    + sec('발급기관 서명 본문', kv([['iss', iss.payload.iss], ['kid', iss.header.kid], ['_sd 해시', `${iss.payload._sd.length}개 (이름·생년월일·연령)`], ['유효기간', ymd(iss.payload.exp * 1000)]]))
    + (kb ? sec('기기 서명 (KB-JWT)', kv([['aud', kb.aud], ['nonce', kb.nonce], ['sd_hash', kb.sd_hash], ['iat', formatKst(kb.iat * 1000)]])) : '');
}
function timingRows(t) {
  return kv([['형식 해석', formatMs(t.parse)], ['발급기관 서명', formatMs(t.issuer_sig)], ['선택공개 해시', formatMs(t.disclosure)], ['기기 서명', formatMs(t.holder_binding)], ['nonce·시각', formatMs(t.nonce)], ['영수증 서명', formatMs(t.receipt)], ['합계', formatMs(t.total)]]);
}
function receiptSections(jws) {
  const d = decodeJws(jws);
  const cert = decodeJws(d.header.scert).payload;
  return sec('영수증 JWS (앞부분)', code(ellipsis(jws, 100, 30)))
    + sec('영수증 헤더', kv([['typ', d.header.typ], ['alg', d.header.alg], ['매장 인증서', `${cert.name} (${cert.sub}) · 등록기관 서명`]]))
    + sec('영수증 본문 (전체 필드)', kv(Object.entries(d.payload).map(([k, v]) => [`${k} · ${RECEIPT_FIELDS[k] || ''}`, (k === 'iat' || k === 'exp') ? `${v} (${formatKst(v * 1000)})` : String(v)])));
}

function drawerHtml() {
  const { s, b } = st.pos;
  const id = SCENES[s].id;
  if (id === 'adult') {
    if (b === 0) {
      const cert = decodeJws(D.ctx.store.cert).payload;
      return sec('매장 인증서', kv([['발급', cert.iss], ['매장', `${cert.name} (${cert.sub})`], ['기한', ymd(cert.exp * 1000)]]))
        + sec('신뢰하는 발급기관', kv([['id', ISSUER.id], ['kid', ISSUER.kid]]))
        + sec('손님 지갑의 항목', kv(Object.entries(D.ctx.adult.claims).map(([k, v]) => [CLAIM_LABELS[k] || k, JSON.stringify(v)])));
    }
    if (b === 1) {
      return sec('검증 요청 (QR 내용)', code(D.req1))
        + sec('보낼 항목', kv(Object.keys(D.ctx.adult.claims).map((k) => [CLAIM_LABELS[k] || k, D.req1.claims.includes(k) ? '보냄' : '보내지 않음'])));
    }
    const o = D.adult.out;
    return sec('검증 결과', `<p class="d-note">결과 ${o.result} · 버린 항목 ${o.report.discarded.length ? o.report.discarded.join(', ') : '없음'}</p>`)
      + sec('검사 순서', checks(o.report, STORE_CHECKS)) + sec('검증 시간 (이번 1회)', timingRows(o.report.timings))
      + vpSections(D.adult.vp) + receiptSections(o.receipt);
  }
  if (id === 'forgery') {
    const kind = SCENES[s].beats[b].attack || 'birth';
    const a = D.atk[kind];
    const head = sec('공격', kv([['유형', ATTACK_LABEL[kind]], ['기대 결과', '서명 검사에서 거부']]));
    if (!a.res) return head + vpSections(a.prep.vp);
    const r = a.res.out.report;
    return head + sec('검사 순서', checks(r, STORE_CHECKS) + `<p class="d-note">실패 이유: ${esc(r.reason)} · 영수증: 만들지 않음</p>`) + vpSections(a.prep.vp);
  }
  if (id === 'audit') {
    const base = receiptSections(D.adult.out.receipt);
    if (!D.audit) return sec('검증 시점', kv([['단속 시점', formatKst(D.adult.at + flow.AUDIT_AFTER_DAYS * DAY)]])) + base;
    return sec('영수증 검사', checks(D.audit.report, RECEIPT_CHECKS)) + sec('검증 시점', kv([['확인 시각', formatKst(D.audit.at)], ['영수증 발급', formatKst(D.adult.at)]])) + base;
  }
  if (id === 'compare') {
    const rows = D.ctx.measures.filter((m) => m.scenario === 'benchmark');
    const avg = (k) => summarize(rows.map((r) => r[k]))?.median;
    return sec('반복 측정', kv([['횟수', String(rows.length)], ['합계 중앙값', formatMs(avg('total_ms'))], ['합계 p95', formatMs(summarize(rows.map((r) => r.total_ms))?.p95)]]))
      + sec('단계별 중앙값', timingRows({ parse: avg('parse_ms'), issuer_sig: avg('issuer_sig_ms'), disclosure: avg('disclosure_ms'), holder_binding: avg('holder_binding_ms'), nonce: avg('nonce_ms'), receipt: avg('receipt_ms'), total: avg('total_ms') }))
      + sec('측정 방법', '<p class="d-note">verifyPresentation 안에서 performance.now()로 단계마다 잰 값이에요. 요청 생성 → 제시물 생성 → 검증 + 영수증 서명을 반복했고, 검증기 쪽 시간만 기록했어요. CSV에는 위조 시도 기록도 함께 들어가요.</p>');
  }
  const S = D.sealed;
  const kb = decodeJws(parseSdJwt(S.token).kbJwt).payload;
  return sec('봉인 조건 (기기 서명에 포함)', kv([['aud', kb.aud], ['purpose', kb.purpose], ['exp', formatKst(kb.exp * 1000)], ['jti', kb.jti]]))
    + sec(b === 2 ? '기한 뒤 검사' : '기한 안 검사', checks(b === 2 ? S.expired : S.valid, { ...STORE_CHECKS, revoked: '철회 여부' }));
}

// ---------- 그리기 ----------
const shown = { left: '', right: '', wire: '' };
function swap(el, key, html) {
  if (shown[key] === html) return;
  shown[key] = html;
  el.innerHTML = html;
}

function render() {
  const { s, b } = st.pos;
  const scene = SCENES[s];
  const beat = scene.beats[b];

  $('sceneNav').querySelectorAll('button').forEach((el, i) => {
    if (i === s) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    el.classList.toggle('is-done', i < s);
  });

  let when = '';
  if (scene.id === 'audit') when = `${formatKst(D.adult.at + flow.AUDIT_AFTER_DAYS * DAY)} · 약 3개월 뒤`;
  else if (scene.id === 'sealed' && D.sealed) when = formatKst([D.sealed.at, D.sealed.at + DAY, D.sealed.expiresAt + DAY][b]);
  else if (scene.id !== 'compare') when = formatKst(D.adult?.at || Date.now());
  $('narrMeta').innerHTML = `<b>장면 ${s + 1}</b> · ${esc(scene.title)}${when ? ` · ${esc(when)}` : ''}`;
  $('narrText').textContent = beat.narr;

  $('narrTools').innerHTML = scene.id === 'forgery'
    ? `<span class="seg-label" id="segLabel">변조 유형</span><div class="seg" role="group" aria-labelledby="segLabel">${flow.ATTACK_KINDS.map((k) => `<button type="button" data-attack="${k}" aria-pressed="${(beat.attack || 'birth') === k}">${ATTACK_LABEL[k]}</button>`).join('')}</div>`
    : '';

  const compare = scene.layout === 'compare';
  $('stage').hidden = compare;
  $('phoneSwitch').hidden = compare;
  $('compare').hidden = !compare;
  if (compare) {
    $('compare').innerHTML = compareHtml();
  } else {
    const v = { adult: sceneAdult, forgery: sceneForgery, audit: sceneAudit, sealed: sceneSealed }[scene.id](b);
    swap($('screenLeft'), 'left', v.left);
    swap($('screenRight'), 'right', v.right);
    swap($('wire'), 'wire', v.wire);
    $('labelLeft').textContent = scene.left;
    $('labelRight').textContent = scene.right;
    $('tabLeft').textContent = scene.left;
    $('tabRight').textContent = scene.right;
    $('stage').dataset.side = st.side;
    $('tabLeft').setAttribute('aria-selected', String(st.side === 'left'));
    $('tabRight').setAttribute('aria-selected', String(st.side === 'right'));
  }

  $('counter').textContent = `${beatIndex(st.pos)} / ${BEAT_COUNT}`;
  $('btnPrev').disabled = !prevPos(st.pos);
  $('btnNext').disabled = !nextPos(st.pos);
  if (st.drawer) $('drawerBody').innerHTML = drawerHtml();
}

async function go(pos) {
  const tok = ++st.token;
  st.pos = pos;
  const beat = SCENES[pos.s].beats[pos.b];
  if (beat.focus) st.side = beat.focus;
  try {
    await prepare(pos);
  } catch (e) {
    console.error(e);
    $('narrText').textContent = `계산 중 문제가 생겼어요: ${e.message}`;
    return;
  }
  if (tok !== st.token) return;
  render();
  syncUrl();
  if (st.playing) schedule(beat.ms);
}

function syncUrl() {
  try {
    const q = new URLSearchParams(location.search);
    q.set('scene', String(st.pos.s + 1));
    q.set('beat', String(st.pos.b + 1));
    history.replaceState(null, '', `?${q}`);
  } catch { /* file:// 등 */ }
}

const next = () => { const n = nextPos(st.pos); if (n) go(n); else if (st.playing) finishPlay(); };
const prev = () => { const p = prevPos(st.pos); if (p) go(p); };

// ---------- 자동 재생 ----------
function schedule(ms) {
  clearTimeout(st.timer);
  st.beatMs = ms;
  st.remaining = ms;
  tick();
}
function tick() {
  st.started = performance.now();
  clearTimeout(st.timer);
  st.timer = setTimeout(() => (nextPos(st.pos) ? next() : finishPlay()), st.remaining);
  cancelAnimationFrame(st.raf);
  const bar = $('progressBar');
  const loop = () => {
    const done = st.beatMs - st.remaining + (performance.now() - st.started);
    bar.style.width = `${Math.min(100, (done / st.beatMs) * 100)}%`;
    if (st.playing) st.raf = requestAnimationFrame(loop);
  };
  loop();
}
function setPlaying(on) {
  const b = $('btnPlay');
  if (on && !nextPos(st.pos) && !st.remaining) { restart(true); return; }
  st.playing = on;
  b.setAttribute('aria-pressed', String(on));
  if (on) {
    b.textContent = '일시정지';
    if (st.remaining > 0) tick(); else schedule(SCENES[st.pos.s].beats[st.pos.b].ms);
  } else {
    clearTimeout(st.timer);
    cancelAnimationFrame(st.raf);
    st.remaining = Math.max(1, st.remaining - (performance.now() - st.started));
    b.textContent = '이어서 재생';
  }
}
function finishPlay() {
  st.playing = false;
  st.remaining = 0;
  cancelAnimationFrame(st.raf);
  $('btnPlay').setAttribute('aria-pressed', 'false');
  $('btnPlay').textContent = '자동 재생';
}
function stopForManual() {
  // 손으로 넘기면 재생 위치를 새 장면 처음으로 맞춘다
  st.remaining = 0;
  $('progressBar').style.width = '0';
  if (!st.playing) $('btnPlay').textContent = '자동 재생';
}

async function restart(play = false) {
  clearTimeout(st.timer);
  st.token++;
  await reset();
  for (const k of Object.keys(shown)) shown[k] = '';
  st.remaining = 0;
  st.playing = play;
  $('btnPlay').setAttribute('aria-pressed', String(play));
  $('btnPlay').textContent = play ? '일시정지' : '자동 재생';
  $('progressBar').style.width = '0';
  await go({ s: 0, b: 0 });
}

// ---------- 서랍 ----------
function setDrawer(open) {
  st.drawer = open;
  const d = $('drawer');
  $('btnDrawer').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('drawer-open', open);
  if (open) {
    d.hidden = false;
    $('drawerBody').innerHTML = drawerHtml();
    requestAnimationFrame(() => d.classList.add('is-open'));
    $('btnDrawerClose').focus();
  } else {
    d.classList.remove('is-open');
    setTimeout(() => { if (!st.drawer) d.hidden = true; }, 220);
    $('btnDrawer').focus();
  }
}

function downloadCsv() {
  const blob = new Blob(['﻿' + toCsv(D.ctx.measures)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `verification-timings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 시작 ----------
function buildNav() {
  $('sceneNav').innerHTML = SCENES.map((sc, i) => `<li><button type="button" data-scene="${i}" class="${sc.short ? 'is-minor' : ''}"><span class="no">${i + 1}</span><span>${sc.short ? `<span class="label-long">확장: </span>${esc(sc.short)}` : esc(sc.title)}</span></button></li>`).join('');
}

function bind() {
  $('sceneNav').addEventListener('click', (e) => {
    const b = e.target.closest('[data-scene]');
    if (b) { stopForManual(); go({ s: Number(b.dataset.scene), b: 0 }); }
  });
  $('btnNext').addEventListener('click', () => { stopForManual(); next(); });
  $('btnPrev').addEventListener('click', () => { stopForManual(); prev(); });
  $('btnRestart').addEventListener('click', () => restart(false));
  $('btnPlay').addEventListener('click', () => setPlaying(!st.playing));
  $('btnDrawer').addEventListener('click', () => setDrawer(!st.drawer));
  $('btnDrawerClose').addEventListener('click', () => setDrawer(false));
  $('phoneSwitch').addEventListener('click', (e) => {
    const t = e.target.closest('[data-side]');
    if (t) { st.side = t.dataset.side; render(); }
  });
  $('narrTools').addEventListener('click', (e) => {
    const t = e.target.closest('[data-attack]');
    if (t) { stopForManual(); go({ s: st.pos.s, b: ATTACK_BEAT[t.dataset.attack] }); }
  });
  document.querySelector('.main').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t || t.disabled) return;
    const act = t.dataset.act;
    if (act === 'next') { stopForManual(); next(); }
    if (act === 'csv') downloadCsv();
    if (act === 'rebench') {
      t.disabled = true;
      D.ctx.measures = D.ctx.measures.filter((m) => m.scenario !== 'benchmark');
      D.bench = await flow.runBenchmark(D.ctx, 30);
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || (e.target instanceof Element && e.target.closest('input, textarea, select'))) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); stopForManual(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); stopForManual(); prev(); }
    else if (e.key === 'Escape' && st.drawer) setDrawer(false);
  });
}

async function main() {
  const q = new URLSearchParams(location.search);
  const w = Number(q.get('w'));
  if (w >= 320 && w < 1200) {
    // 화면 폭 강제(모바일 배치 확인용). 레이아웃은 컨테이너 쿼리라 그대로 반응한다.
    $('shell').style.maxWidth = `${w}px`;
    $('shell').classList.add('is-forced');
  }
  buildNav();
  bind();
  await reset();
  const pos = posFromQuery(location.search);
  // 바로 뒤 장면으로 들어와도 앞 장면 데이터가 실제로 만들어지도록 순서대로 준비한다
  for (let i = 0; i < pos.s; i++) await prepare({ s: i, b: SCENES[i].beats.length - 1 });
  await go(pos);
  if (q.get('drawer') === '1') setDrawer(true);
  document.documentElement.dataset.ready = '1';
}

main().catch((e) => { console.error(e); $('narrText').textContent = `시작하지 못했어요: ${e.message}`; });
