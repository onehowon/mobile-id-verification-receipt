// 장면별 스크린샷 + 콘솔 오류·잘림 확인 (Chrome DevTools 프로토콜, 외부 패키지 없음. Node 22 이상)
// 사용: python3 scripts/serve.py 8799 &
//       node scripts/shoot.mjs http://localhost:8799/ docs/screens          장면 × 화면 크기 스크린샷
//       node scripts/shoot.mjs http://localhost:8799/ docs/screens --play   자동 재생을 처음부터 끝까지 한 번(약 2분)
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8799/';
const OUT = process.argv[3] || 'docs/screens';
const PLAY = process.argv.includes('--play');
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const SCENES = [
  { name: '1-result', q: 'scene=1&beat=4', mobile: true },
  { name: '1-scan', q: 'scene=1&beat=2', mobile: true, expect: 'scanning' },
  { name: '1-scan-ok', q: 'scene=1&beat=2', mobile: true, wait: 3200, expect: 'ok' },
  { name: '1-consent', q: 'scene=1&beat=3', mobile: true },
  { name: '2-birth', q: 'scene=2&beat=2', mobile: true },
  { name: '2-forge', q: 'scene=2&beat=3' },
  { name: '2-replay', q: 'scene=2&beat=4' },
  { name: '3-audit-now', q: 'scene=3&beat=1' },
  { name: '3-audit', q: 'scene=3&beat=3', mobile: true },
  { name: '3-owner', q: 'scene=3&beat=4', mobile: true },
  { name: '4-compare', q: 'scene=4', mobile: true },
  { name: '5-sealed', q: 'scene=5&beat=3', mobile: true },
];
const VIEWPORTS = [
  { tag: '1440', width: 1440, height: 900 },
  { tag: '1280', width: 1280, height: 720 },
];
const MOBILE = { tag: 'mobile', width: 390, height: 844, deviceScaleFactor: 2, mobile: true };

const SHOTS = [
  ...SCENES.flatMap((s) => VIEWPORTS.map((v) => ({ ...s, file: `${s.name}-${v.tag}.png`, vp: v }))),
  ...SCENES.filter((s) => s.mobile).map((s) => ({ ...s, file: `${s.name}-mobile.png`, vp: MOBILE })),
  { file: 'drawer-1440.png', q: 'scene=1&beat=4&drawer=1', vp: VIEWPORTS[0] },
  { file: 'drawer-audit-1440.png', q: 'scene=3&beat=3&drawer=1', vp: VIEWPORTS[0] },
  { file: 'drawer-scan-1440.png', q: 'scene=1&beat=2&drawer=1', vp: VIEWPORTS[0], wait: 3200, expect: 'ok' },
  { file: '1-result-1920.png', q: 'scene=1&beat=4', vp: { tag: '1920', width: 1920, height: 1080 } },
].filter((s) => !ONLY || s.file.includes(ONLY));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 화면 안 잘림 검사: 폰 프레임이 자막·조작 막대와 겹치지 않는지, 폰 안 본문이 스크롤 없이 다 보이는지
const LAYOUT_CHECK = `(async () => {
  const out = [];
  const R = (el) => el.getBoundingClientRect();
  if (document.documentElement.scrollWidth > innerWidth) out.push('가로 넘침');
  const controls = R(document.querySelector('.controls'));
  const stage = document.getElementById('stage');
  if (!stage.hidden) {
    for (const id of ['deviceLeft', 'deviceRight']) {
      const slot = document.getElementById(id);
      if (getComputedStyle(slot).display === 'none') continue;
      const box = R(slot.querySelector('.phone-box'));
      if (box.bottom > controls.top + 0.5) out.push(id + ': 조작 막대와 겹침 ' + Math.round(box.bottom - controls.top) + 'px');
      if (box.top < R(document.querySelector('.narr')).bottom - 0.5) out.push(id + ': 자막과 겹침');
      if (box.right > innerWidth + 0.5 || box.left < -0.5) out.push(id + ': 화면 밖');
      const doc = slot.querySelector('iframe').contentDocument;
      for (const c of doc.querySelectorAll('ion-content')) {
        if (!c.getScrollElement || c.closest('ion-modal')) continue;
        const sc = await c.getScrollElement();
        const over = sc.scrollHeight - sc.clientHeight;
        if (over > 1) out.push(id + ': 폰 안 본문이 ' + over + 'px 넘침(스크롤 필요)');
      }
      for (const m of doc.querySelectorAll('ion-modal')) {
        const sheet = m.querySelector('.sheet');
        if (!sheet) continue;
        const btn = R(sheet.querySelector('ion-button') || sheet);
        if (btn.bottom > doc.defaultView.innerHeight - 4) out.push(id + ': 바텀시트 버튼이 화면 밖 ' + Math.round(btn.bottom - doc.defaultView.innerHeight) + 'px');
      }
      // 카메라 화면: 안내 → 가이드 → 인식 표시 → 손전등·닫기가 위에서 아래로 겹치지 않고 화면 안에
      const cam = doc.querySelector('.cam');
      if (cam) {
        const parts = ['.cam-hint', '.cam-guide', '.cam-status', '.cam-bar'].map((q) => cam.querySelector(q)).filter((el) => el && el.getBoundingClientRect().height > 0).map(R);
        for (let i = 1; i < parts.length; i++) if (parts[i].top < parts[i - 1].bottom - 0.5) out.push(id + ': 카메라 화면 요소 겹침 ' + i);
        if (parts.at(-1).bottom > doc.defaultView.innerHeight + 0.5) out.push(id + ': 카메라 버튼이 화면 밖');
        if (cam.querySelector('.cam-feed') && !cam.querySelector('.cam-feed').complete) out.push(id + ': 카메라 사진이 안 그려짐');
      }
      for (const el of doc.querySelectorAll('.result-title, .lead, ion-label h3, ion-label p, ion-note')) {
        if (el.scrollWidth > el.clientWidth + 1) out.push(id + ': 가로 잘림 「' + el.textContent.trim().slice(0, 20) + '」');
      }
    }
    const wire = document.getElementById('wire');
    if (wire.offsetParent && R(wire).bottom > controls.top) out.push('가운데 카드가 조작 막대와 겹침');
  } else {
    const main = document.getElementById('main');
    if (main.scrollHeight > main.clientHeight + 1) out.push('비교표가 세로로 넘침 ' + (main.scrollHeight - main.clientHeight) + 'px');
  }
  return out;
})()`;

async function openTab(errors, label) {
  const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(`${label}: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push(`${label}: console.${m.params.type} ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (m.method === 'Log.entryAdded' && ['error', 'warning'].includes(m.params.entry.level)) errors.push(`${label}: ${m.params.entry.level} ${m.params.entry.text} ${m.params.entry.url || ''}`);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) errors.push(`${label}: 검사 스크립트 오류 ${r.result.exceptionDetails.exception?.description}`);
    return r.result?.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  // 같은 출처 iframe(폰)의 콘솔도 같은 세션에서 잡힌다 (Runtime은 모든 프레임 컨텍스트를 본다)
  return { send, evaluate, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {}); } };
}

async function waitReady(evaluate, label, errors) {
  for (let i = 0; i < 150; i++) {
    await sleep(100);
    const ok = await evaluate(`document.documentElement.dataset.ready === "1" && (document.getElementById('stage').hidden || document.documentElement.dataset.phones === "ok") && document.fonts.status === "loaded" && [...document.querySelectorAll('iframe')].every((f) => f.contentDocument?.fonts.status === 'loaded')`);
    if (ok) return true;
  }
  errors.push(`${label}: 준비 신호 없음`);
  return false;
}

async function shoot(errors, problems) {
  for (const shot of SHOTS) {
    const tab = await openTab(errors, shot.file);
    const v = shot.vp;
    await tab.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor || 1, mobile: !!v.mobile });
    await tab.send('Page.navigate', { url: `${BASE}?${shot.q}` });
    await waitReady(tab.evaluate, shot.file, errors);
    await sleep(shot.wait || 900); // 바텀시트 올라오는 애니메이션, 카메라 인식(2.2초 뒤)
    const issues = await tab.evaluate(LAYOUT_CHECK);
    if (shot.expect) {
      // 손님 폰 카메라가 실제 디코드 결과로 바뀌었는지 (ok = 매장 요청과 nonce까지 일치)
      const state = await tab.evaluate(`document.getElementById('screenLeft').contentDocument.querySelector('.cam')?.dataset.state`);
      if (state !== shot.expect) problems.push(`${shot.file}: 카메라 상태 ${state} (기대 ${shot.expect})`);
    }
    for (const x of issues || []) problems.push(`${shot.file}: ${x}`);
    const png = await tab.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT, shot.file), Buffer.from(png.result.data, 'base64'));
    await tab.close();
    console.log('saved', join(OUT, shot.file));
  }
}

async function playThrough(errors, problems) {
  const tab = await openTab(errors, 'autoplay');
  await tab.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await tab.send('Page.navigate', { url: BASE });
  await waitReady(tab.evaluate, 'autoplay', errors);
  await tab.evaluate(`document.getElementById('btnPlay').click()`);
  const t0 = Date.now();
  let last = '';
  for (;;) {
    await sleep(500);
    const s = await tab.evaluate(`({ c: document.getElementById('counter').textContent, p: document.getElementById('btnPlay').getAttribute('aria-pressed'), n: document.getElementById('narrText').textContent })`);
    if (s.c !== last) {
      last = s.c;
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s  ${s.c}`);
      await sleep(1500);
      for (const x of (await tab.evaluate(LAYOUT_CHECK)) || []) problems.push(`autoplay ${s.c}: ${x}`);
      if (s.n.includes('문제가 생겼어요')) errors.push(`autoplay ${s.c}: ${s.n}`);
    }
    if (s.p === 'false' && Date.now() - t0 > 5000) { console.log(`자동 재생 끝: ${s.c}, ${((Date.now() - t0) / 1000).toFixed(0)}초`); break; }
    if (Date.now() - t0 > 200000) { errors.push('자동 재생이 끝나지 않음'); break; }
  }
  await tab.close();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shoot-'))}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { await sleep(200); ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null); }
  const errors = [];
  const problems = [];
  try {
    if (PLAY) await playThrough(errors, problems); else await shoot(errors, problems);
  } finally {
    chrome.kill();
  }
  console.log(errors.length ? `콘솔 오류 ${errors.length}건\n${[...new Set(errors)].join('\n')}` : '콘솔 오류 0건');
  console.log(problems.length ? `잘림·겹침 ${problems.length}건\n${[...new Set(problems)].join('\n')}` : '잘림·겹침 0건');
  process.exitCode = errors.length || problems.length ? 1 : 0;
}
main();
