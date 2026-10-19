// 화면만 담당한다. 서명·검증·영수증은 lib/demo-flow.js가 실제로 수행하고, 여기서는 그 결과를 그린다.
import { decodeJws } from './lib/jose.js';
import { ISSUER } from './lib/demo-keys.js';
import { CHECKS, CLAIM_LABELS, parseSdJwt, decodeDisclosure } from './lib/sdjwt.js';
import { RECEIPT_CHECKS, RECEIPT_FIELDS, RETENTION_DAYS } from './lib/receipt.js';
import { STEPS_ASIS, STEPS_TOBE, toCsv, summarize } from './lib/measure.js';
import { SCENES, BEAT_COUNT, nextPos, prevPos, beatIndex, posFromQuery, formatKst, formatMs, ellipsis } from './lib/scenes.js';
import * as flow from './lib/demo-flow.js';
import { sceneView, esc, ymd, auditAt, sealedAt } from './screens.js';
import { matchScannedRequest } from './lib/scan.js';
import { renderCameraFrame, decodeFrame, FRAME_W, FRAME_H, DECODER } from './camera.js';

const $ = (id) => document.getElementById(id);
const DAY = flow.DAY_MS;
const NONCE_SAFE_MS = 90000; // 요청 유효 120초보다 먼저 새로 만든다 (발표 중 멈춰 있어도 실패하지 않게)
const ATTACK_BEAT = { birth: 1, forge: 2, replay: 3 };
const SCAN_DELAY_MS = 2200; // 카메라를 비추고 인식하기까지(연출). 인식 자체는 그 순간 실제로 디코드한다
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
  if (D.scanFrame?.nonce !== D.req1.nonce) {
    // 손님 카메라에 비친 사진: 매장 폰이 띄운 것과 같은 요청 글자로 같은 QR을 그린다
    const canvas = renderCameraFrame(JSON.stringify(D.req1));
    D.scanFrame = { nonce: D.req1.nonce, canvas, url: canvas ? canvas.toDataURL('image/jpeg', 0.86) : '' };
  }
}
/** 손님 앱이 사진에서 QR을 실제로 읽고, 읽은 요청이 매장이 띄운 요청(nonce 포함)과 같은지 확인 */
function scanNow() {
  ensureReq1();
  if (D.scan?.nonce === D.req1.nonce) return D.scan;
  const r = decodeFrame(D.scanFrame.canvas);
  D.scan = { nonce: D.req1.nonce, text: r.text, ms: r.ms, version: r.version, ...matchScannedRequest(r.text, D.req1) };
  return D.scan;
}
function ensureScanned() {
  const r = scanNow();
  if (!r.ok) throw new Error(`손님 앱이 QR을 인식하지 못했어요 (${r.reason})`);
}
async function ensureAdult() {
  if (D.adult) return;
  ensureScanned();
  // 손님 앱은 QR에서 읽은 요청에 답한다
  D.adult = await flow.runAdultCheck(D.ctx, { request: D.scan.req });
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
    if (b >= 2) ensureScanned();
    if (b >= 3) await ensureAdult();
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

// ---------- 화면 조각은 screens.js (Ionic 마크업) ----------

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

function scanDrawer() {
  const r = D.scan?.nonce === D.req1.nonce ? D.scan : null;
  const frame = (more = []) => sec('촬영 이미지', kv([['디코더', DECODER], ['사진', `${FRAME_W}×${FRAME_H} · 매장 폰 화면을 기울이고 흐리게 찍은 모습`], ...more]));
  if (!r) return sec('QR에서 읽은 요청', '<p class="d-note">아직 인식 전이에요. 카메라에 비친 사진의 픽셀만으로 QR을 읽어요.</p>') + frame() + sec('매장이 띄운 요청', code(D.req1));
  const q = r.req || {};
  return sec('QR에서 읽은 요청', r.req ? kv([
    ['확인 항목', (q.claims || []).map((k) => CLAIM_LABELS[k] || k).join(', ')],
    ['nonce', q.nonce],
    ['유효시간', typeof q.exp === 'number' ? `${formatKst(q.exp * 1000)}까지 (발행 후 120초, 1회용)` : '-'],
    ['매장', `${q.store} (${q.aud})`],
    ['목적', q.purpose],
  ]) : '<p class="d-note">읽은 내용이 없어요</p>')
    + sec('매장 요청과 대조', kv([['nonce', q.nonce === D.req1.nonce ? '일치' : '다름'], ['판정', r.ok ? '일치 · 동의 화면으로' : r.reason]]))
    + frame([['QR 버전', r.version ? String(r.version) : '-'], ['인식 시간', formatMs(r.ms)]])
    + sec('읽은 원문', code(r.text || ''));
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
    if (SCENES[s].beats[b].scan) return scanDrawer();
    if (b === 2) {
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

// ---------- 폰 두 대 (각각 iframe 안의 Ionic 앱) ----------
// 폰 화면은 phone.html?role=customer|store 에서 그린다. 바깥 KRDS 스타일과 Ionic 전역 스타일이 섞이지 않는다.
const PHONE_W = 428; // devices.css iPhone 14 Pro 프레임 크기(px)
const PHONE_H = 868;
const phones = {
  left: { frame: () => $('screenLeft'), ready: false, pending: null, acked: 0 },
  right: { frame: () => $('screenRight'), ready: false, pending: null, acked: 0 },
};
let screenSeq = 0;
const roleSide = { customer: 'left', store: 'right' };
const isFrameless = () => getComputedStyle($('stage')).getPropertyValue('--frameless').trim() === '1';

function sendScreen(side, html, time) {
  const p = phones[side];
  p.pending = { type: 'screen', html, time, frame: !isFrameless(), seq: screenSeq };
  document.documentElement.dataset.phones = 'pending';
  if (p.ready) p.frame().contentWindow.postMessage(p.pending, location.origin);
}
function checkPhonesDone() {
  if (phones.left.acked === screenSeq && phones.right.acked === screenSeq) document.documentElement.dataset.phones = 'ok';
}
window.addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data || typeof e.data !== 'object') return;
  const side = roleSide[e.data.role];
  if (!side || e.source !== phones[side].frame().contentWindow) return;
  const p = phones[side];
  if (e.data.type === 'hello') {
    p.ready = true;
    if (p.pending) p.frame().contentWindow.postMessage(p.pending, location.origin);
  } else if (e.data.type === 'rendered') {
    p.acked = e.data.seq;
    checkPhonesDone();
  } else if (e.data.type === 'act') {
    if (e.data.act === 'next') { stopForManual(); next(); }
  } else if (e.data.type === 'key') {
    onKey(e.data.key);
  }
});

// 폰이 바깥보다 먼저 준비됐을 수 있으니 이쪽에서도 한 번 묻는다
for (const p of Object.values(phones)) {
  const f = p.frame();
  const ping = () => f.contentWindow?.postMessage({ type: 'ping' }, location.origin);
  f.addEventListener('load', ping);
  ping();
}

/** 무대 높이·폭에 맞춰 폰 프레임 배율을 정한다 (위아래 베젤까지 다 보이게) */
function fitPhones() {
  const stage = $('stage');
  if (stage.hidden) return;
  if (isFrameless()) { stage.style.removeProperty('--s'); return; }
  const label = $('labelLeft').getBoundingClientRect().height + 10;
  const cs = getComputedStyle(stage);
  const gap = parseFloat(cs.columnGap) || 0;
  const wireW = $('wire').getBoundingClientRect().width;
  const h = stage.clientHeight - label;
  const w = (stage.clientWidth - wireW - gap * 2) / 2;
  const s = Math.max(0.3, Math.min(1, h / PHONE_H, w / PHONE_W));
  stage.style.setProperty('--s', s.toFixed(4));
}

let lastView = null;
function renderPhones() {
  if (!lastView) return;
  screenSeq++;
  sendScreen('left', lastView.left, lastView.time[0]);
  sendScreen('right', lastView.right, lastView.time[1]);
}

// ---------- 그리기 ----------
let shownWire = '';

function render() {
  const { s, b } = st.pos;
  const scene = SCENES[s];
  const beat = scene.beats[b];

  $('sceneNav').querySelectorAll('button').forEach((el, i) => {
    if (i === s) el.setAttribute('aria-current', 'step'); else el.removeAttribute('aria-current');
    el.classList.toggle('is-done', i < s);
  });

  let when = '';
  if (scene.id === 'audit') when = `${formatKst(auditAt(D))} · 약 3개월 뒤`;
  else if (scene.id === 'sealed' && D.sealed) when = formatKst(sealedAt(D, b));
  else if (scene.id !== 'compare') when = formatKst(D.adult?.at || Date.now());
  $('narrMeta').innerHTML = `<b>장면 ${s + 1}</b><span>${esc(scene.title)}</span>${when ? `<span>${esc(when)}</span>` : ''}`;
  $('narrText').textContent = beat.narr;

  $('narrTools').innerHTML = scene.id === 'forgery'
    ? `<div class="seg" role="group" aria-label="변조 유형">${flow.ATTACK_KINDS.map((k) => `<button type="button" data-attack="${k}" aria-pressed="${(beat.attack || 'birth') === k}">${ATTACK_LABEL[k]}</button>`).join('')}</div>`
    : '';

  const compare = scene.layout === 'compare';
  $('stage').hidden = compare;
  $('phoneSwitch').hidden = compare;
  $('compare').hidden = !compare;
  $('main').classList.toggle('is-compare', compare);
  if (compare) {
    $('compare').innerHTML = compareHtml();
  } else {
    const v = sceneView(D, st.pos);
    lastView = v;
    if (v.wire !== shownWire) { shownWire = v.wire; $('wire').innerHTML = v.wire; }
    $('labelLeft').textContent = scene.left;
    $('labelRight').textContent = scene.right;
    $('tabLeft').textContent = scene.left;
    $('tabRight').textContent = scene.right;
    $('stage').dataset.side = st.side;
    $('tabLeft').setAttribute('aria-selected', String(st.side === 'left'));
    $('tabRight').setAttribute('aria-selected', String(st.side === 'right'));
    fitPhones();
    renderPhones();
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
  if (beat.scan && D.scan?.nonce !== D.req1.nonce) {
    // 카메라를 잠시 비춘 뒤 그 사진을 실제로 디코드하고, 결과(초록 가이드 + 인식했어요)를 그린다
    setTimeout(() => {
      if (tok !== st.token) return;
      scanNow();
      render();
    }, SCAN_DELAY_MS);
  }
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
  shownWire = '';
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
    if (onKey(e.key)) e.preventDefault();
  });
  // 창 크기·서랍 열림에 따라 폰 배율을 다시 계산하고, 프레임 유무가 바뀌면 화면을 다시 보낸다
  let wasFrameless = null;
  new ResizeObserver(() => {
    const fl = isFrameless();
    fitPhones();
    if (wasFrameless !== null && fl !== wasFrameless) renderPhones();
    wasFrameless = fl;
  }).observe($('stage'));
}

function onKey(key) {
  if (key === 'ArrowRight') { stopForManual(); next(); return true; }
  if (key === 'ArrowLeft') { stopForManual(); prev(); return true; }
  if (key === 'Escape' && st.drawer) { setDrawer(false); return true; }
  return false;
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
  // 화면 폭 강제나 서랍처럼 늦게 바뀐 크기도 반영
  requestAnimationFrame(fitPhones);
}

main().catch((e) => { console.error(e); $('narrText').textContent = `시작하지 못했어요: ${e.message}`; });
