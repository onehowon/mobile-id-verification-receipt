// UI. 암호·검증 로직은 lib/ 모듈에 있고, 여기서는 화면과 브라우저 저장소만 다룬다.
import { generateKeyJwk, decodeJws, sha256, b64uJson, jsonFromB64u } from './lib/jose.js';
import { ISSUER, REGISTRY } from './lib/demo-keys.js';
import { issueCredential, createPresentation, readCredential, parseSdJwt, decodeDisclosure, CHECKS, CLAIM_LABELS, ageOn } from './lib/sdjwt.js';
import { NonceRegistry, createRequest, parseRequest, verifyAtStore, AGE_CLAIM } from './lib/verifier.js';
import { createStoreCert, verifyReceipt, RECEIPT_CHECKS, RECEIPT_FIELDS } from './lib/receipt.js';
import { ATTACKS, tamperBirth, forgeWithFakeIssuer, stealAndRebind } from './lib/tamper.js';
import { createSealedCopy, verifySealedCopy } from './lib/sealed.js';
import { STEPS_ASIS, STEPS_TOBE, toRow, toCsv, summarize } from './lib/measure.js';

const $ = (id) => document.getElementById(id);
const DAY_MS = 86400000;
const KEY = 'vreceipt-demo-v1';
const STORE = { id: 'STORE-DEMO-0001', name: '가상 주점 (데모)' };
const RECIPIENTS = { 'GOV-DEMO-0001': '가상 구청 민원실', 'GOV-DEMO-0002': '가상 공단 지사' };

// ---------- 저장소 ----------
const S = {
  holderJwk: null, creds: [], activeCred: 0, history: [], sealed: [], revoked: [],
  storeJwk: null, storeCert: null, nonces: {}, receipts: [], stats: { Y: 0, N: 0, fail: 0 },
  measures: [], lastRequest: null, lastVp: null, flow: {},
};
function load() {
  try { Object.assign(S, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { /* 저장소 없음: 메모리로만 동작 */ }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({ ...S, measures: S.measures.slice(-500) })); } catch { /* 무시 */ }
}
const registry = () => new NonceRegistry(S.nonces);
const storeCtx = () => ({ ...STORE, jwk: S.storeJwk, cert: S.storeCert });

// ---------- 공통 UI ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (sec) => new Date(sec * 1000).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'medium' });
const short = (s, n = 10) => (s && s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-6)}` : s || '');

let toastTimer;
function toast(msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2400);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했습니다'); } catch { toast('복사할 수 없는 환경입니다. 원문을 직접 선택하세요'); }
}

function badge(ok) {
  if (ok === true) return '<span class="krds-badge bg-light-success">통과</span>';
  if (ok === false) return '<span class="krds-badge bg-light-danger">실패</span>';
  return '<span class="krds-badge bg-light-disabled">미실행</span>';
}

function checksTable(report, labels, caption) {
  const byId = Object.fromEntries(report.checks.map((c) => [c.id, c]));
  const ids = [...Object.keys(labels), ...report.checks.map((c) => c.id).filter((id) => !(id in labels))];
  const rows = ids.map((id) => {
    const c = byId[id];
    return `<tr class="${c && !c.ok ? 'is-failed' : ''}"><th scope="row">${esc(c ? c.label : labels[id])}</th><td>${badge(c ? c.ok : null)}</td><td class="detail">${esc(c ? c.detail : '')}</td></tr>`;
  }).join('');
  return `<div class="krds-table-wrap"><table class="tbl col data"><caption>${esc(caption)}</caption>
    <thead><tr><th scope="col">검사</th><th scope="col">결과</th><th scope="col">내용</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function resultBox(kind, label, main, sub) {
  const cls = { y: 'is-y', n: 'is-n', fail: 'is-fail' }[kind];
  return `<div class="result ${cls}" role="status"><p class="result-label">${esc(label)}</p><p class="result-main">${esc(main)}</p>${sub ? `<p class="result-sub">${esc(sub)}</p>` : ''}</div>`;
}

const STORE_CHECK_ORDER = Object.fromEntries(['format', 'issuer_sig', 'validity', 'disclosure', 'holder_binding', 'audience', 'nonce', 'freshness', 'claim'].map((k) => [k, CHECKS[k]]));

function storeResultHtml(out, { showReceipt = true } = {}) {
  const { report, result, receipt } = out;
  let head;
  if (!report.ok) head = resultBox('fail', '검증 결과', '검증 실패', report.reason);
  else if (result === 'Y') head = resultBox('y', '검증 결과', '만 19세 이상 확인', '직원 화면에는 이 결과만 표시됩니다. 이름·생년월일은 전달되지 않았습니다.');
  else head = resultBox('n', '검증 결과', '만 19세 미만', '판매 불가. 정상 신분증으로 확인된 결과입니다.');
  const ms = `<p class="muted">검증 소요 ${report.timings.total.toFixed(1)} ms${report.timings.receipt ? ` (영수증 서명 ${report.timings.receipt.toFixed(1)} ms 포함)` : ''}${report.discarded.length ? ` · 요청하지 않은 항목 ${report.discarded.length}개는 표시·보관하지 않고 버림` : ''}</p>`;
  const rc = showReceipt && receipt ? `<p class="muted">영수증을 발급해 보관했습니다. 영수증 번호 ${esc(decodeJws(receipt).payload.rid)}</p>` : '';
  return head + ms + rc + checksTable(report, STORE_CHECK_ORDER, '제시물 검증 단계별 결과');
}

// ---------- 진행 단계 ----------
function markFlow(step) {
  S.flow[step] = true;
  save();
  renderFlow();
}
function renderFlow() {
  const order = ['issue', 'present', 'verify', 'receipt'];
  const firstTodo = order.find((s) => !S.flow[s]);
  document.querySelectorAll('#flowSteps li').forEach((li) => {
    const s = li.dataset.step;
    li.classList.toggle('done', !!S.flow[s]);
    li.classList.toggle('active', s === firstTodo);
  });
}

// ---------- 탭 ----------
function showTab(name) {
  document.querySelectorAll('#tablist li').forEach((li) => {
    const on = li.querySelector('button').dataset.tab === name;
    li.classList.toggle('active', on);
    li.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-conts').forEach((p) => {
    const on = p.id === `panel-${name}`;
    p.hidden = !on;
    p.classList.toggle('active', on);
  });
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
  stopScanners();
}

// ---------- QR ----------
function qrLib() { return typeof window.qrcode === 'function' ? window.qrcode : null; }
function drawQr(canvas, text, { x = 0, y = 0, size = canvas.width } = {}) {
  const lib = qrLib();
  const ctx = canvas.getContext('2d');
  if (!lib) {
    ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
    ctx.fillStyle = '#333'; ctx.font = '14px sans-serif'; ctx.fillText('QR 라이브러리 없음', x + 10, y + size / 2);
    return false;
  }
  lib.stringToBytes = lib.stringToBytesFuncs['UTF-8'];
  const qr = lib(0, 'M'); // L은 버전 23(109모듈)에서 jsQR 1.4.0이 읽지 못해 M을 쓴다
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.floor(size / (n + quiet * 2));
  const off = Math.floor((size - cell * n) / 2);
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
  return true;
}

function decodeQrFromCanvas(canvas) {
  if (typeof window.jsQR !== 'function') return null;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const res = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!res) return null;
  try { return new TextDecoder().decode(new Uint8Array(res.binaryData)); } catch { return res.data; }
}

const scanners = new Set();
function stopScanners() { for (const s of scanners) s(); scanners.clear(); }

async function startScanner(container, onText) {
  stopScanners();
  if (typeof window.jsQR !== 'function') { toast('QR 인식 라이브러리를 불러오지 못했습니다. 붙여넣기를 쓰세요'); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { toast('이 환경은 카메라를 지원하지 않습니다 (localhost 또는 https 필요)'); return; }
  container.hidden = false;
  container.innerHTML = '<video playsinline muted></video><div class="btn-row"><button type="button" class="krds-btn small tertiary">스캔 중지</button></div>';
  const video = container.querySelector('video');
  const canvas = document.createElement('canvas');
  let stream, raf, stopped = false;
  const stop = () => {
    stopped = true;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    container.hidden = true;
    container.innerHTML = '';
  };
  scanners.add(stop);
  container.querySelector('button').onclick = () => { scanners.delete(stop); stop(); };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch (e) {
    stop();
    toast(`카메라를 열 수 없습니다: ${e.name}`);
    return;
  }
  video.srcObject = stream;
  await video.play();
  const tick = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = Math.min(960, video.videoWidth);
      canvas.width = w;
      canvas.height = Math.round(video.videoHeight * (w / video.videoWidth));
      canvas.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, canvas.width, canvas.height);
      const text = decodeQrFromCanvas(canvas);
      if (text) { scanners.delete(stop); stop(); onText(text); return; }
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
}

function readQrFromFile(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(decodeQrFromCanvas(c));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- 측정 기록 ----------
function record(scenario, out) {
  const outcome = out.report.ok ? out.result : 'FAIL';
  S.measures.push(toRow({ scenario, outcome, report: out.report, ua: navigator.userAgent }));
  save();
  renderMeasures();
}

// ---------- 1. 발급기관 ----------
const PRESETS = { adult: ['김민준', '1995-03-14'], minor: ['이서연', '2009-08-02'] };

async function onIssue() {
  const name = $('issName').value.trim();
  const birthdate = $('issBirth').value;
  if (!name || !birthdate) { toast('이름과 생년월일을 입력하세요'); return; }
  const { sdjwt, payload, disclosures } = await issueCredential({ name, birthdate }, { issuer: ISSUER, holderJwk: S.holderJwk });
  S.creds.push({ sdjwt, issuedAt: Date.now() });
  S.activeCred = S.creds.length - 1;
  markFlow('issue');
  save();
  const rows = disclosures.map((d) => `<tr><th scope="row">${esc(CLAIM_LABELS[d.name])}</th><td>${esc(String(d.value))}</td><td class="detail mono">${esc(short(d.encoded, 8))}</td><td class="detail mono">${esc(short(d.digest, 8))}</td></tr>`).join('');
  $('issueOut').innerHTML = `
    ${resultBox('y', '발급 완료', `${name} · 만 ${ageOn(birthdate)}세`, '지갑에 저장했습니다. 지갑 탭에서 확인하세요.')}
    <div class="krds-table-wrap scroll-x"><table class="tbl col data"><caption>항목별 공개값과 해시</caption>
      <thead><tr><th scope="col">항목</th><th scope="col">값</th><th scope="col">공개값(salt 포함)</th><th scope="col">서명된 해시</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted">발급기관 서명에는 해시 ${payload._sd.length}개와 지갑 공개키만 들어가고, 이름·생년월일 평문은 들어가지 않습니다.</p>
    <dl class="kv"><dt>발급기관</dt><dd>${esc(ISSUER.name)}</dd><dt>유효기간</dt><dd>${fmtTime(payload.exp)}까지</dd><dt>지갑 키 바인딩</dt><dd class="mono">cnf.jwk x=${esc(short(payload.cnf.jwk.x, 8))}</dd></dl>`;
  renderWallet();
}

// ---------- 2. 지갑 ----------
let pendingRequest = null;

function renderWallet() {
  const box = $('walletCred');
  if (!S.creds.length) { box.innerHTML = '<p class="muted">자격증명이 없습니다. 발급기관 탭에서 발급하세요.</p>'; return; }
  box.innerHTML = S.creds.map((c, i) => {
    const { claims, payload } = readCredential(c.sdjwt);
    const active = i === S.activeCred;
    return `<div class="id-card ${active ? 'active' : ''}">
      <div class="id-card-head"><strong>모바일 신분증 (가상)</strong>${active ? '<span class="krds-badge bg-primary">사용 중</span>' : `<button type="button" class="krds-btn xsmall tertiary" data-use="${i}">이것으로 제시</button>`}</div>
      <dl class="kv"><dt>이름</dt><dd>${esc(claims.name)}</dd><dt>생년월일</dt><dd>${esc(claims.birthdate)}</dd><dt>만 19세 이상</dt><dd>${claims.age_over_19 ? '예' : '아니오'}</dd><dt>유효기간</dt><dd>${fmtTime(payload.exp)}</dd></dl>
    </div>`;
  }).join('');
  box.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => { S.activeCred = Number(b.dataset.use); save(); renderWallet(); }; });
  renderHistory();
}

function renderHistory() {
  const items = [
    ...S.history.map((h) => ({ at: h.at, html: `<div class="meta"><strong>${esc(h.storeName)}</strong><span class="muted">${esc(h.purpose)} · 「만 19세 이상」만 제공 · ${fmtTime(h.at)}</span><span class="muted mono">제시물 해시 ${esc(short(h.vpHash, 8))}</span></div>` })),
    ...S.sealed.map((s) => ({ at: s.at, html: `<div class="meta"><strong>${esc(RECIPIENTS[s.recipient] || s.recipient)} (봉인 사본)</strong><span class="muted">${esc(s.purpose)} · ${esc(s.fields.map((f) => CLAIM_LABELS[f]).join(', '))} · 기한 ${fmtTime(s.exp)}</span></div>${S.revoked.includes(s.jti) ? '<span class="krds-badge bg-light-gray">철회됨</span>' : `<button type="button" class="krds-btn xsmall tertiary" data-revoke="${esc(s.jti)}">철회</button>`}` })),
  ].sort((a, b) => b.at - a.at);
  $('walletHistory').innerHTML = items.length ? `<ul class="list-plain">${items.map((i) => `<li>${i.html}</li>`).join('')}</ul>` : '<p class="muted">아직 제출한 내역이 없습니다.</p>';
  $('walletHistory').querySelectorAll('[data-revoke]').forEach((b) => { b.onclick = () => { S.revoked.push(b.dataset.revoke); save(); renderHistory(); toast('철회했습니다. 이 사본은 이제 검증에서 무효입니다'); }; });
}

function onRequestText(text) {
  $('reqIn').value = text;
  let req;
  try { req = parseRequest(text); } catch (e) { $('consent').innerHTML = resultBox('fail', '요청 확인', '요청을 읽을 수 없습니다', e.message); return; }
  pendingRequest = req;
  const items = req.claims.map((c) => `「${CLAIM_LABELS[c] || c}」`).join(', ');
  $('consent').innerHTML = `<div class="consent">
    <p><strong>${esc(req.store)}</strong>(${esc(req.aud)})이 ${esc(items)} 여부만 요청합니다.</p>
    <p class="muted">목적: ${esc(req.purpose)} · 이름·생년월일은 전달되지 않습니다.</p>
    <div class="btn-row"><button type="button" class="krds-btn primary medium" id="btnConsent">${esc(items)} 여부만 제공</button><button type="button" class="krds-btn medium tertiary" id="btnDecline">거절</button></div></div>`;
  $('btnConsent').onclick = onPresent;
  $('btnDecline').onclick = () => { pendingRequest = null; $('consent').innerHTML = ''; };
}

async function onPresent() {
  const req = pendingRequest;
  if (!req) return;
  const cred = S.creds[S.activeCred];
  if (!cred) { toast('지갑에 자격증명이 없습니다'); return; }
  const vp = await createPresentation(cred.sdjwt, { disclose: req.claims, nonce: req.nonce, aud: req.aud, holderJwk: S.holderJwk });
  S.lastVp = vp;
  S.history.push({ at: Math.floor(Date.now() / 1000), storeName: req.store, purpose: req.purpose, vpHash: await sha256(vp) });
  markFlow('present');
  save();
  $('vpBox').hidden = false;
  drawQr($('vpQr'), vp);
  $('vpText').value = vp;
  const { disclosures } = parseSdJwt(vp);
  $('vpMeta').textContent = `공개 항목 ${disclosures.length}개(${disclosures.map((d) => CLAIM_LABELS[decodeDisclosure(d).name]).join(', ')}) · ${vp.length}자 · 요청 nonce ${short(req.nonce, 6)}`;
  $('consent').innerHTML = '';
  pendingRequest = null;
  renderHistory();
  $('vpBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- 3. 검증(매장) ----------
let reqTimer;
function onNewRequest() {
  const reg = registry();
  const req = createRequest(reg, { storeId: STORE.id, storeName: STORE.name });
  S.nonces = reg.state;
  S.lastRequest = req;
  save();
  $('reqOut').hidden = false;
  drawQr($('reqQr'), JSON.stringify(req));
  const exp = Date.now() + reg.ttlSec * 1000;
  clearInterval(reqTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((exp - Date.now()) / 1000));
    $('reqMeta').textContent = `nonce ${short(req.nonce, 6)} · 1회용 · 남은 시간 ${left}초`;
    if (!left) clearInterval(reqTimer);
  };
  tick();
  reqTimer = setInterval(tick, 1000);
}

async function runStoreVerify(vp, scenario) {
  const reg = registry();
  const out = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store: storeCtx() });
  S.nonces = reg.state;
  if (out.report.ok) {
    S.stats[out.result] += 1;
    S.receipts.unshift({ jws: out.receipt, at: Date.now() });
  } else {
    S.stats.fail += 1;
  }
  save();
  record(scenario, out);
  renderReceipts();
  renderStats();
  return out;
}

async function onVerify() {
  const vp = $('vpIn').value.trim();
  if (!vp) { toast('제시물을 넣으세요'); return; }
  const out = await runStoreVerify(vp, 'manual');
  if (out.report.ok) { markFlow('verify'); markFlow('receipt'); }
  $('verifyOut').innerHTML = `<div class="box">${storeResultHtml(out)}</div>`;
  $('verifyOut').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReceipts() {
  const box = $('receiptList');
  if (!S.receipts.length) { box.innerHTML = '<p class="muted">보관 중인 영수증이 없습니다.</p>'; } else {
    box.innerHTML = `<ul class="list-plain">${S.receipts.slice(0, 10).map((r, i) => {
      const p = decodeJws(r.jws).payload;
      return `<li><div class="meta"><strong>${p.result === 'Y' ? '만 19세 이상 (Y)' : '만 19세 미만 (N)'} · ${esc(p.rid)}</strong><span class="muted">${fmtTime(p.iat)} · 파기 예정 ${new Date(p.exp * 1000).toLocaleDateString('ko-KR')}</span></div>
        <span class="btn-row" style="margin:0"><button type="button" class="krds-btn xsmall tertiary" data-rc-copy="${i}">복사</button><button type="button" class="krds-btn xsmall secondary" data-rc-open="${i}">분쟁 검증</button></span></li>`;
    }).join('')}</ul>${S.receipts.length > 10 ? `<p class="muted">최근 10건만 표시 · 전체 ${S.receipts.length}건</p>` : ''}`;
    box.querySelectorAll('[data-rc-copy]').forEach((b) => { b.onclick = () => copy(S.receipts[Number(b.dataset.rcCopy)].jws); });
    box.querySelectorAll('[data-rc-open]').forEach((b) => { b.onclick = () => { $('rcIn').value = S.receipts[Number(b.dataset.rcOpen)].jws; showTab('dispute'); onReceiptVerify(); }; });
  }
  const pick = $('rcPick');
  pick.innerHTML = '<option value="">선택</option>' + S.receipts.slice(0, 20).map((r, i) => {
    const p = decodeJws(r.jws).payload;
    return `<option value="${i}">${esc(p.rid)} · ${p.result} · ${fmtTime(p.iat)}</option>`;
  }).join('');
}

function renderStats() {
  const s = S.stats;
  $('stats').innerHTML = `<div class="stat-row">
    <div class="stat"><span class="k">전체</span><span class="v">${s.Y + s.N + s.fail}</span></div>
    <div class="stat"><span class="k">Y</span><span class="v">${s.Y}</span></div>
    <div class="stat"><span class="k">N</span><span class="v">${s.N}</span></div>
    <div class="stat"><span class="k">검증 실패</span><span class="v">${s.fail}</span></div></div>
    <p class="muted">통계에는 건수만 남습니다. 누가, 언제, 어느 매장에서 확인했는지는 집계되지 않습니다.</p>`;
}

// ---------- 4. 분쟁 검증 ----------
async function onReceiptVerify() {
  const jws = $('rcIn').value.trim();
  if (!jws) { toast('영수증을 넣으세요'); return; }
  const days = Number(document.querySelector('input[name="rcWhen"]:checked').value);
  const now = Date.now() + days * DAY_MS;
  const v = await verifyReceipt(jws, { registryJwk: REGISTRY.jwk, now });
  let head;
  if (v.ok) head = resultBox(v.payload.result === 'Y' ? 'y' : 'n', days ? `${days}일 후 시점으로 검증` : '영수증 검증', `유효한 영수증 · 결과 ${v.payload.result}`, `${v.store.name}이 ${fmtTime(v.payload.iat)}에 「만 19세 이상」을 확인했습니다.`);
  else head = resultBox('fail', days ? `${days}일 후 시점으로 검증` : '영수증 검증', '유효하지 않은 영수증', v.reason);
  let fields = '';
  if (v.payload) {
    const rows = Object.entries(v.payload).map(([k, val]) => {
      const shown = k === 'iat' || k === 'exp' ? `${val} (${fmtTime(val)})` : String(val);
      return `<tr><th scope="row" class="mono">${esc(k)}</th><td>${esc(RECEIPT_FIELDS[k] || '허용되지 않은 필드')}</td><td class="detail mono">${esc(shown)}</td></tr>`;
    }).join('');
    fields = `<h3 class="box-title" style="margin-top:2rem">영수증에 들어 있는 전부</h3>
      <div class="krds-table-wrap scroll-x"><table class="tbl col data"><caption>영수증 필드 목록</caption><thead><tr><th scope="col">필드</th><th scope="col">의미</th><th scope="col">값</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted">이름, 생년월일, 주민등록번호, 사진, 지갑 키가 없습니다. 제시물 해시는 매번 새 nonce로 만들어져 같은 사람의 다른 영수증과 연결되지 않습니다.</p>`;
  }
  $('rcOut').innerHTML = `<div class="box">${head}${checksTable(v, RECEIPT_CHECKS, '영수증 검증 단계별 결과')}${fields}</div>`;
}

function onReceiptTamper() {
  const jws = $('rcIn').value.trim();
  try {
    const [h, p, s] = jws.split('.');
    const payload = jsonFromB64u(p);
    payload.result = payload.result === 'Y' ? 'N' : 'Y';
    $('rcIn').value = `${h}.${b64uJson(payload)}.${s}`;
    toast(`결과를 ${payload.result}(으)로 바꿨습니다. 검증해 보세요`);
  } catch { toast('먼저 영수증을 넣으세요'); }
}

// ---------- 5. 위조 시연 ----------
let tempKeys = null;
async function attackerFixtures() {
  // 위조 시연에 쓰는 가상 인물 둘(지갑과 별개). 발급은 진짜 발급기관이 했다.
  if (tempKeys) return tempKeys;
  const minorHolder = await generateKeyJwk();
  const adultHolder = await generateKeyJwk();
  const minor = (await issueCredential({ name: '박하준', birthdate: '2009-05-20' }, { issuer: ISSUER, holderJwk: minorHolder })).sdjwt;
  const adult = (await issueCredential({ name: '최지우', birthdate: '1998-11-02' }, { issuer: ISSUER, holderJwk: adultHolder })).sdjwt;
  tempKeys = { minorHolder, adultHolder, minor, adult };
  return tempKeys;
}

function freshRequest() {
  const reg = registry();
  const req = createRequest(reg, { storeId: STORE.id, storeName: STORE.name });
  S.nonces = reg.state;
  save();
  return req;
}

let captureVp = null;
async function makeCapture() {
  const f = await attackerFixtures();
  if (!captureVp) {
    // 어제 성인 친구가 실제로 제시해 이미 쓰인 QR (nonce 소모됨)
    const req = freshRequest();
    captureVp = await createPresentation(f.adult, { disclose: [AGE_CLAIM], nonce: req.nonce, aud: req.aud, holderJwk: f.adultHolder });
    const reg = registry();
    await verifyAtStore(captureVp, { issuerJwk: ISSUER.jwk, registry: reg, store: storeCtx() });
    S.nonces = reg.state;
    save();
  }
  const c = $('capCanvas');
  const ctx = c.getContext('2d');
  ctx.setTransform(2, 0, 0, 2, 0, 0); // 360x560 좌표로 그리고 2배 해상도로 저장
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#0b50d0'; ctx.fillRect(0, 0, c.width, 56);
  ctx.fillStyle = '#ffffff'; ctx.font = 'bold 18px "Pretendard GOV", sans-serif'; ctx.fillText('모바일 주민등록증 (가상)', 20, 35);
  ctx.fillStyle = '#e6e8ea'; ctx.fillRect(20, 76, 90, 110);
  ctx.fillStyle = '#6d7882'; ctx.font = '13px sans-serif'; ctx.fillText('사진', 50, 136);
  ctx.fillStyle = '#1e2124'; ctx.font = 'bold 22px "Pretendard GOV", sans-serif'; ctx.fillText('최지우', 128, 106);
  ctx.font = '16px "Pretendard GOV", sans-serif';
  ctx.fillStyle = '#d63d4a'; ctx.fillText(`생년월일 ${$('capBirth').value || '2000-01-01'}`, 128, 140);
  ctx.fillStyle = '#6d7882'; ctx.font = '12px sans-serif'; ctx.fillText('(이미지 편집으로 고친 값)', 128, 162);
  drawQr(c, captureVp, { x: 40, y: 200, size: 280 });
  ctx.fillStyle = '#6d7882'; ctx.font = '12px sans-serif'; ctx.fillText('화면 캡처 · 위조 시연용 이미지', 92, 540);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  $('capNote').textContent = '이미지 속 QR은 성인 친구가 어제 실제로 제시해 이미 사용된 제시물입니다. 생년월일 글자는 마음대로 고칠 수 있지만 QR 안의 서명은 고칠 수 없습니다.';
}

async function onCaptureScan() {
  if (!captureVp) await makeCapture();
  let text = decodeQrFromCanvas($('capCanvas'));
  let note = '이미지에서 QR을 읽어 검증했습니다.';
  if (!text) { text = captureVp; note = 'QR 인식 라이브러리가 없어 이미지 속 제시물 원문으로 검증했습니다.'; }
  const out = await runStoreVerify(text, 'capture_replay');
  $('capOut').innerHTML = `<p class="muted">${esc(note)}</p>${storeResultHtml(out)}`;
}

function renderAttackRows() {
  $('attackRows').innerHTML = Object.entries(ATTACKS).map(([k, a]) => `<tr>
    <th scope="row">${esc(a.title)}</th><td class="detail">${esc(a.desc)}</td><td>${esc(CHECKS[a.expect])}</td>
    <td><button type="button" class="krds-btn xsmall secondary" data-attack="${k}">실행</button></td></tr>`).join('');
  $('attackRows').querySelectorAll('[data-attack]').forEach((b) => { b.onclick = () => runAttack(b.dataset.attack); });
}

async function runAttack(kind) {
  const f = await attackerFixtures();
  let vp;
  const req = freshRequest();
  if (kind === 'birth') {
    const honest = await createPresentation(f.minor, { disclose: [AGE_CLAIM], nonce: req.nonce, aud: req.aud, holderJwk: f.minorHolder });
    vp = tamperBirth(honest);
  } else if (kind === 'forge') {
    vp = await forgeWithFakeIssuer({ issuer: ISSUER, nonce: req.nonce, aud: req.aud });
  } else if (kind === 'replay') {
    vp = await createPresentation(f.adult, { disclose: [AGE_CLAIM], nonce: req.nonce, aud: req.aud, holderJwk: f.adultHolder });
    await runStoreVerify(vp, 'replay_first_use'); // 첫 사용은 정상
  } else if (kind === 'stolen') {
    const victim = await createPresentation(f.adult, { disclose: [AGE_CLAIM], nonce: 'old', aud: req.aud, holderJwk: f.adultHolder });
    vp = await stealAndRebind(victim, { nonce: req.nonce, aud: req.aud });
  }
  const out = await runStoreVerify(vp, `attack_${kind}`);
  const a = ATTACKS[kind];
  const hit = out.report.failed === a.expect;
  $('attackOut').innerHTML = `<div class="box" style="margin-top:1.6rem"><h3 class="box-title">${esc(a.title)}</h3>
    ${storeResultHtml(out)}
    <p class="muted">${hit ? `예상대로 「${esc(CHECKS[a.expect])}」 검사에서 막혔습니다.` : '예상과 다른 단계에서 처리되었습니다.'} 실패한 제시물에는 영수증을 발급하지 않습니다.</p></div>`;
}

// ---------- 6. 측정 ----------
function renderSteps() {
  const tbl = (title, steps) => `<div><p class="steps-big">${steps.length}단계</p><div class="krds-table-wrap"><table class="tbl col data"><caption>${esc(title)}</caption>
    <thead><tr><th scope="col">순서</th><th scope="col">${esc(title)}</th><th scope="col">누가</th></tr></thead>
    <tbody>${steps.map((s, i) => `<tr><td>${i + 1}</td><td>${esc(s.step)}</td><td>${esc(s.who)}</td></tr>`).join('')}</tbody></table></div></div>`;
  $('stepsCompare').innerHTML = tbl('기존 방식', STEPS_ASIS) + tbl('검증 결과 영수증', STEPS_TOBE);
}

const SCEN_LABEL = {
  manual: '직접 검증', bench: '벤치마크', capture_replay: '캡처 화면', replay_first_use: '재사용(첫 사용)',
  attack_birth: '생년 변조', attack_forge: '서명 위조', attack_replay: '재사용 nonce', attack_stolen: '탈취',
};
function renderMeasures() {
  const rows = S.measures.slice(-50).reverse();
  const td = (v) => `<td class="num">${v === '' ? '-' : v.toFixed ? v.toFixed(2) : v}</td>`;
  $('measureRows').innerHTML = rows.length ? rows.map((r) => `<tr><td>${esc(new Date(r.time).toLocaleTimeString('ko-KR'))}</td><td>${esc(SCEN_LABEL[r.scenario] || r.scenario)}</td><td>${r.outcome === 'FAIL' ? `<span class="krds-badge bg-light-danger">실패</span> <span class="detail">${esc(CHECKS[r.failed_check] || r.failed_check)}</span>` : `<span class="krds-badge bg-light-success">${esc(r.outcome)}</span>`}</td>${td(r.issuer_sig_ms)}${td(r.disclosure_ms)}${td(r.holder_binding_ms)}${td(r.receipt_ms)}${td(r.total_ms)}</tr>`).join('')
    : '<tr><td colspan="8">기록이 없습니다. 검증을 실행하거나 「정상 검증 30회 실행」을 누르세요.</td></tr>';
  const ok = S.measures.filter((r) => r.outcome !== 'FAIL');
  const s = summarize(ok.map((r) => r.total_ms));
  $('measureSummary').innerHTML = s ? `<div class="stat-row" style="margin-top:1.6rem">
    <div class="stat"><span class="k">성공 검증 (건)</span><span class="v">${s.n}</span></div>
    <div class="stat"><span class="k">중앙값 (ms)</span><span class="v">${s.median.toFixed(1)}</span></div>
    <div class="stat"><span class="k">평균 (ms)</span><span class="v">${s.mean.toFixed(1)}</span></div>
    <div class="stat"><span class="k">p95 (ms)</span><span class="v">${s.p95.toFixed(1)}</span></div></div>
    <p class="muted">영수증 서명까지 포함한 검증기 처리 시간입니다. QR 인식과 사람의 화면 확인 시간은 포함하지 않습니다.</p>` : '';
}

async function onBench() {
  const btn = $('btnBench');
  btn.disabled = true;
  const f = await attackerFixtures();
  for (let i = 0; i < 30; i++) {
    btn.textContent = `실행 중 ${i + 1}/30`;
    const req = freshRequest();
    const vp = await createPresentation(f.adult, { disclose: [AGE_CLAIM], nonce: req.nonce, aud: req.aud, holderJwk: f.adultHolder });
    await runStoreVerify(vp, 'bench');
  }
  btn.textContent = '정상 검증 30회 실행';
  btn.disabled = false;
  toast('30회 실행했습니다');
}

function onCsv() {
  const blob = new Blob(['﻿' + toCsv(S.measures)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `verification-timing-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 7. 봉인 사본 ----------
const SEALED_ORDER = Object.fromEntries(['format', 'issuer_sig', 'validity', 'disclosure', 'holder_binding', 'audience', 'freshness', 'claim'].map((k) => [k, CHECKS[k]]));

async function onSeal() {
  const cred = S.creds[S.activeCred];
  if (!cred) { toast('지갑에 자격증명이 없습니다. 먼저 발급하세요'); return; }
  const fields = [['sName', 'name'], ['sBirth', 'birthdate']].filter(([id]) => $(id).checked).map(([, f]) => f);
  if (!fields.length) { toast('공개 항목을 하나 이상 고르세요'); return; }
  const recipient = $('sRecipient').value;
  const purpose = $('sPurpose').value.trim() || '본인 확인';
  const expiresAt = Date.now() + Number($('sDays').value) * DAY_MS;
  const { token, jti } = await createSealedCopy(cred.sdjwt, { disclose: fields, recipient, purpose, expiresAt, holderJwk: S.holderJwk });
  S.sealed.push({ at: Math.floor(Date.now() / 1000), jti, recipient, purpose, fields, exp: Math.floor(expiresAt / 1000), token });
  save();
  $('sIn').value = token;
  $('sAs').value = recipient;
  $('sealOut').innerHTML = `<p class="muted" style="margin-top:1.6rem">${esc(RECIPIENTS[recipient])} 앞으로 ${fmtTime(Math.floor(expiresAt / 1000))}까지 유효한 사본을 만들었습니다(${token.length}자). 오른쪽 확인 칸에 넣어 두었습니다.</p>
    <div class="btn-row"><button type="button" class="krds-btn small tertiary" id="btnSealCopy">사본 복사</button></div>`;
  $('btnSealCopy').onclick = () => copy(token);
  renderHistory();
}

async function onSealVerify() {
  const token = $('sIn').value.trim();
  if (!token) { toast('사본을 넣으세요'); return; }
  let now = Date.now();
  if ($('sWhen').value === 'after') {
    try {
      const { kbJwt } = parseSdJwt(token);
      now = decodeJws(kbJwt).payload.exp * 1000 + DAY_MS;
    } catch { /* 형식 오류는 검증에서 보고 */ }
  }
  const recipient = $('sAs').value;
  const v = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient, now, revoked: S.revoked });
  const order = { ...SEALED_ORDER, revoked: '철회 여부' };
  let head;
  if (v.ok) {
    const shown = Object.entries(v.claims).map(([k, val]) => `${CLAIM_LABELS[k]} ${val}`).join(' · ');
    head = resultBox('y', `${RECIPIENTS[recipient]} 확인`, '유효한 봉인 사본', `${shown} · 목적: ${v.kb.purpose} · 기한 ${fmtTime(v.kb.exp)}`);
  } else {
    head = resultBox('fail', `${RECIPIENTS[recipient]} 확인`, '무효', v.reason);
  }
  $('sealVerifyOut').innerHTML = head + checksTable(v, order, '봉인 사본 검증 단계별 결과') + '<p class="muted">사본 이미지가 없으므로, 기한이 지나면 기관 서랍에 남아 있어도 신분 확인 용도로 다시 쓸 수 없습니다.</p>';
}

// ---------- 초기화 ----------
async function init() {
  load();
  if (!S.holderJwk) S.holderJwk = await generateKeyJwk();
  if (!S.storeJwk) {
    S.storeJwk = await generateKeyJwk();
    S.storeCert = await createStoreCert({ storeId: STORE.id, storeName: STORE.name, storeJwk: S.storeJwk }, REGISTRY);
  }
  save();

  document.querySelectorAll('#tablist button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  const initial = location.hash.slice(1);
  showTab(document.getElementById(`panel-${initial}`) ? initial : 'issuer');

  document.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => { const [n, d] = PRESETS[b.dataset.preset]; $('issName').value = n; $('issBirth').value = d; }; });
  $('btnIssue').onclick = onIssue;

  $('reqIn').addEventListener('change', () => onRequestText($('reqIn').value.trim()));
  $('btnReqScan').onclick = () => startScanner($('scanReq'), onRequestText);
  $('btnReqLocal').onclick = () => {
    load();
    if (!S.lastRequest) { toast('검증 탭에서 먼저 요청을 만드세요'); return; }
    onRequestText(JSON.stringify(S.lastRequest));
  };
  $('btnVpCopy').onclick = () => copy($('vpText').value);
  $('btnVpSend').onclick = () => { $('vpIn').value = S.lastVp || ''; showTab('verifier'); };

  $('storeInfo').textContent = `${STORE.name} · ${STORE.id} · 매장 키 등록됨(가상 등록기관 서명)`;
  $('btnNewReq').onclick = onNewRequest;
  $('btnVpScan').onclick = () => startScanner($('scanVp'), (t) => { $('vpIn').value = t; onVerify(); });
  $('vpImg').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await readQrFromFile(file).catch(() => null);
    e.target.value = '';
    if (!text) { $('vpIn').value = ''; $('verifyOut').innerHTML = `<div class="box">${resultBox('fail', '이미지 확인', 'QR을 찾지 못했습니다', '서명된 제시물이 없는 화면은 검증할 수 없습니다. 육안 확인용 화면 캡처는 증거가 되지 않습니다.')}</div>`; return; }
    $('vpIn').value = text;
    onVerify();
  };
  $('btnVpLocal').onclick = () => { load(); $('vpIn').value = S.lastVp || ''; if (!S.lastVp) toast('지갑에서 먼저 제시하세요'); };
  $('btnVerify').onclick = onVerify;

  $('rcPick').onchange = () => { const i = $('rcPick').value; if (i !== '') $('rcIn').value = S.receipts[Number(i)].jws; };
  $('btnRcVerify').onclick = onReceiptVerify;
  $('btnRcTamper').onclick = onReceiptTamper;

  $('btnCapMake').onclick = makeCapture;
  $('capBirth').onchange = () => { if (captureVp) makeCapture(); };
  $('btnCapScan').onclick = onCaptureScan;
  renderAttackRows();

  $('btnBench').onclick = onBench;
  $('btnCsv').onclick = onCsv;
  $('btnClearM').onclick = () => { S.measures = []; save(); renderMeasures(); };

  $('btnSeal').onclick = onSeal;
  $('btnSealVerify').onclick = onSealVerify;

  renderFlow();
  renderWallet();
  renderReceipts();
  renderStats();
  renderSteps();
  renderMeasures();
  document.documentElement.dataset.ready = '1';
}

// 외부 스크립트(defer)보다 모듈이 먼저 끝날 수 있어 load 이후 QR 기능을 쓴다. 초기화 자체는 바로 한다.
init().catch((e) => {
  console.error(e);
  document.getElementById('main').insertAdjacentHTML('afterbegin', `<div class="result is-fail"><p class="result-main">초기화 실패</p><p class="result-sub">${esc(e.message)} (WebCrypto는 https 또는 localhost에서만 동작합니다)</p></div>`);
});

// 헤드리스 점검용 훅
window.__demo = { S, onIssue, onNewRequest, onRequestText, onPresent, onVerify, onReceiptVerify, runAttack, onCaptureScan, makeCapture, onBench, onSeal, onSealVerify, showTab };
