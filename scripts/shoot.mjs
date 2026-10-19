// 장면별 스크린샷 + 콘솔 오류 확인 (Chrome DevTools 프로토콜, 외부 패키지 없음. Node 22 이상)
// 사용: python3 scripts/serve.py 8799 & node scripts/shoot.mjs http://localhost:8799/ docs/screens
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.argv[2] || 'http://localhost:8799/';
const OUT = process.argv[3] || 'docs/screens';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const SHOTS = [
  { file: '1-adult.png', q: 'scene=1&beat=3' },
  { file: '1-consent.png', q: 'scene=1&beat=2' },
  { file: '2-forgery.png', q: 'scene=2&beat=3' },
  { file: '3-audit.png', q: 'scene=3&beat=3' },
  { file: '3-audit-now.png', q: 'scene=3&beat=1' },
  { file: '4-compare.png', q: 'scene=4' },
  { file: '5-sealed.png', q: 'scene=5&beat=3' },
  { file: 'drawer.png', q: 'scene=1&beat=3&drawer=1' },
  { file: 'mobile.png', q: 'scene=1&beat=3', mobile: true },
  { file: 'mobile-consent.png', q: 'scene=1&beat=2', mobile: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'shoot-'))}`, '--no-first-run', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { await sleep(200); ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null); }
  const errors = [];
  try {
    for (const shot of SHOTS) {
      const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      let id = 0;
      const pending = new Map();
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
        if (m.method === 'Runtime.exceptionThrown') errors.push(`${shot.file}: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
        if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push(`${shot.file}: console.${m.params.type} ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
        if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(`${shot.file}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
      });
      const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
      await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
      if (shot.mobile) {
        await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
      } else {
        await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      }
      await send('Page.navigate', { url: `${BASE}?${shot.q}` });
      let ready = false;
      for (let i = 0; i < 100 && !ready; i++) {
        await sleep(100);
        const r = await send('Runtime.evaluate', { expression: 'document.documentElement.dataset.ready === "1" && document.fonts.status === "loaded"', returnByValue: true });
        ready = r.result?.result?.value === true;
      }
      if (!ready) errors.push(`${shot.file}: 준비 신호 없음`);
      await sleep(700);
      const over = await send('Runtime.evaluate', { expression: 'document.documentElement.scrollWidth > window.innerWidth', returnByValue: true });
      if (over.result?.result?.value) errors.push(`${shot.file}: 가로 넘침`);
      const png = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(OUT, shot.file), Buffer.from(png.result.data, 'base64'));
      ws.close();
      await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
      console.log('saved', join(OUT, shot.file));
    }
  } finally {
    chrome.kill();
  }
  console.log(errors.length ? `오류 ${errors.length}건\n${errors.join('\n')}` : '콘솔 오류 0건');
  process.exitCode = errors.length ? 1 : 0;
}
main();
