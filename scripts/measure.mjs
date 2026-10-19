// 이 기기 측정: 헤드리스 Chrome에서 단계별 소요 시간을 n회 재서 docs/measurements.md에 표로 쓴다.
// 사용: python3 scripts/serve.py 8799 &
//       node scripts/measure.mjs http://localhost:8799/ [회수=30]
// 두 번 잰다: 데스크톱(감속 없음), 모바일 에뮬레이션(390×844, CPU 4배 감속). 실제 휴대폰 측정이 아니다.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://localhost:8799/';
const N = Number(process.argv[3]) || 30;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9334;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tab() {
  const t = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const RUN = (n) => `(async () => {
  const flow = await import('./lib/demo-flow.js');
  const cam = await import('./camera.js');
  const ctx = await flow.setupDemo();
  // 앱과 같이: 첫 프레임을 못 읽으면 다음 프레임(최대 SCAN_FRAMES장)을 읽는다. 시간은 읽은 프레임들의 디코드 시간 합
  const frames = [];
  const decodeQr = (text) => {
    let ms = 0;
    for (let f = 0; f < cam.SCAN_FRAMES; f++) {
      const r = cam.decodeFrame(cam.renderCameraFrame(text, f));
      ms += r.ms;
      if (r.text === text) { frames.push(f + 1); return { ok: true, ms }; }
    }
    return { ok: false, ms };
  };
  await flow.measureStages(ctx, { n: 3, decodeQr }); // 예열(JIT·키 가져오기), 기록하지 않음
  const rows = await flow.measureStages(ctx, { n: ${n}, decodeQr });
  return { rows, ua: navigator.userAgent, hc: navigator.hardwareConcurrency, frames: frames.slice(3) };
})()`;

async function measure(t, { label, mobile }) {
  if (mobile) {
    await t.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await t.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  } else {
    await t.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await t.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  await t.send('Page.enable');
  await t.send('Page.navigate', { url: `${BASE}?scene=1&beat=1` });
  for (let i = 0; i < 200; i++) { await sleep(100); if (await t.evaluate(`document.documentElement.dataset.ready === "1" && typeof jsQR === "function"`).catch(() => false)) break; }
  const out = await t.evaluate(RUN(N));
  console.log(label, out.rows.length, '회');
  return { label, ...out };
}

const STAGES = [
  ['qr_decode', 'QR 디코드 (카메라 사진 780×1660, jsQR)'],
  ['issuer_sig', '발급기관 서명 검증 (매장)'],
  ['store_verify', '매장 검증 전체 (파싱~거래 결합)'],
  ['receipt_sign', '영수증 매장 서명'],
  ['audit_15', '구청 재검증 15단계 (원장 대조 포함)'],
];
function stats(v) {
  const s = [...v].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
}
const f = (x) => x.toFixed(2);
function table(run) {
  const lines = ['| 단계 | 회수 | 중앙값 (ms) | p95 (ms) | 최소 | 최대 | 평균 |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const [k, name] of STAGES) {
    const s = stats(run.rows.map((r) => r[k]));
    lines.push(`| ${name} | ${s.n} | ${f(s.median)} | ${f(s.p95)} | ${f(s.min)} | ${f(s.max)} | ${f(s.mean)} |`);
  }
  return lines.join('\n');
}

async function main() {
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'measure-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 50 && !ver; i++) { await sleep(200); ver = await fetch(`http://127.0.0.1:${PORT}/json/version`).then((r) => r.json()).catch(() => null); }
  const runs = [];
  try {
    const t = await tab();
    runs.push(await measure(t, { label: '데스크톱 Chrome (감속 없음, 1440×900)', mobile: false }));
    const t2 = await tab();
    runs.push(await measure(t2, { label: 'Chrome 모바일 에뮬레이션 (390×844, CPU 4배 감속)', mobile: true }));
    t.close(); t2.close();
  } finally { chrome.kill(); }

  let model = '';
  try { model = execSync('sysctl -n machdep.cpu.brand_string').toString().trim(); } catch { model = cpus()[0]?.model || ''; }
  let hw = '';
  try { hw = execSync('sysctl -n hw.model').toString().trim(); } catch { /* */ }
  const date = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 16);
  const md = `# 이 기기 측정 결과

> **실제 휴대폰 측정이 아닙니다.** 개발용 데스크톱에서 헤드리스 Chrome으로 잰 값입니다. 모바일 행은 Chrome DevTools의 CPU 4배 감속 에뮬레이션이며, 실제 휴대폰의 CPU·열·브라우저 차이를 반영하지 않습니다.

## 측정 환경

| 항목 | 값 |
|---|---|
| 날짜 (KST) | ${date} |
| 기기 | ${hw} · ${model} · 논리 코어 ${cpus().length}개 · 메모리 ${Math.round(totalmem() / 2 ** 30)}GB · Darwin ${release()} |
| 브라우저 | ${ver?.Browser || '-'} (헤드리스) |
| User-Agent (데스크톱) | \`${runs[0].ua}\` |
| 코드 | 이 저장소 \`lib/demo-flow.js\`의 \`measureStages\`, 실행 스크립트 \`scripts/measure.mjs\` |
| 방법 | 판매 1건마다 새 매장 요청·새 1회용 증명. 예열 3회 뒤 ${N}회 기록. \`performance.now()\` |

## 단계

- QR 디코드: 매장 요청 QR이 찍힌 카메라 사진(합성, 780×1660, 기울기·흐림)을 jsQR 1.4.0이 픽셀만 보고 디코드한 시간. 앱과 같이 첫 프레임을 못 읽으면 다음 프레임(최대 3장)을 읽으며, 시간은 그 프레임들의 디코드 합입니다. 사진 합성 시간은 뺐습니다.
- 발급기관 서명 검증: 매장 검증앱이 제시물의 발급기관 ES256 서명을 확인한 시간.
- 매장 검증 전체: 파싱·발급기관 서명·공개 항목·손님 서명(KB-JWT)·nonce·거래 결합.
- 영수증 매장 서명: 영수증 v2를 매장 키(ES256)로 서명한 시간.
- 구청 재검증 15단계: \`verifyReceiptV2\` 전체(매장 인증서·매장 서명·발급기관 서명·손님 서명·원장 확인 서명·원장 증명 해시 대조 등).

포함하지 않는 것: 카메라 초점·인식 대기, 사람이 화면을 보고 누르는 시간, 네트워크 전송.

주의: 이 페이지는 교차 출처 격리가 없어 브라우저가 `performance.now()` 해상도를 0.1ms로 낮춥니다. 1ms 미만 값은 0.1ms 단위로만 읽어야 합니다.

${runs.map((r) => `## ${r.label}\n\n${table(r)}\n\nQR을 읽기까지 쓴 프레임 수: 1장 ${r.frames.filter((x) => x === 1).length}회 · 2장 ${r.frames.filter((x) => x === 2).length}회 · 3장 ${r.frames.filter((x) => x === 3).length}회\n`).join('\n')}`;
  writeFileSync('docs/measurements.md', md);
  console.log(md);
}
main();
