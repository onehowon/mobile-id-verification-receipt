// 손님 앱 카메라에 찍힌 한 장면을 그리고, 그 사진에서 QR을 실제로 읽는다.
// 사진: 매장 폰 화면(같은 요청으로 만든 같은 QR)을 약간 기울고 흐리게 찍은 모습. 원근은 lib/scan.js의 호모그래피.
// 읽기: jsQR 1.4.0이 이 사진의 픽셀만 보고 디코드한다. 매장 요청과 맞는지는 app.js가 matchScannedRequest로 판정.
import { homography, project } from './lib/scan.js';
import { makeQr } from './screens.js';

export const FRAME_W = 780; // 폰 화면 390×830의 2배
export const FRAME_H = 1660;
export const DECODER = 'jsQR 1.4.0';

// 매장 폰 화면 좌표(390×830, 매장 앱의 「QR 보여 주기」 배치와 같음)
const QR = { x: 75, y: 182, s: 240 };

/** 매장 폰 위 사각형(둥근 모서리)을 사진 좌표 다각형으로 */
function rrect(H, x, y, w, h, r = 0) {
  if (!r) return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => project(H, a, b));
  const pts = [];
  const arc = (cx, cy, a0) => { for (let i = 0; i <= 6; i++) { const a = a0 + (i / 6) * (Math.PI / 2); pts.push(project(H, cx + r * Math.cos(a), cy + r * Math.sin(a))); } };
  arc(x + w - r, y + r, -Math.PI / 2);
  arc(x + w - r, y + h - r, 0);
  arc(x + r, y + h - r, Math.PI / 2);
  arc(x + r, y + r, Math.PI);
  return pts;
}
function fill(ctx, pts, color) {
  ctx.beginPath();
  pts.forEach(([a, b], i) => (i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

/** 요청 글자로 카메라 사진(canvas)을 만든다. QR 라이브러리가 없으면 null.
 *  frame: 연속 촬영의 몇 번째 프레임인지(0부터). 손이 조금씩 움직여 각도·거리가 달라진다 */
export function renderCameraFrame(text, frame = 0) {
  const q = makeQr(text);
  if (!q) return null;
  const W = FRAME_W, H0 = FRAME_H;
  const raw = document.createElement('canvas');
  raw.width = W; raw.height = H0;
  const ctx = raw.getContext('2d');
  ctx.fillStyle = '#2b2d30'; // 매장 카운터 바닥
  ctx.fillRect(0, 0, W, H0);

  // QR 네 모서리가 사진에서 놓일 자리: 화면 가운데, 폭의 54%, 위쪽이 살짝 멀고(원근) 시계 반대로 5도 기울어짐
  const s = W * (0.54 + 0.03 * frame), cx = W / 2, cy = H0 / 2;
  const rot = ((-5 + 2 * frame) * Math.PI) / 180;
  const corners = [[-0.47, -0.5], [0.47, -0.49], [0.52, 0.5], [-0.51, 0.51]].map(([a, b]) => {
    const x = a * s, y = b * s;
    return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)];
  });
  const H = homography([[QR.x, QR.y], [QR.x + QR.s, QR.y], [QR.x + QR.s, QR.y + QR.s], [QR.x, QR.y + QR.s]], corners);

  // 매장 폰: 베젤 → 화면 → 앱 화면 요소(글자는 초점 밖이라 막대로)
  fill(ctx, rrect(H, -14, -14, 418, 858, 60), '#0d0e0f');
  fill(ctx, rrect(H, 0, 0, 390, 830, 47), '#f4f5f6');
  fill(ctx, rrect(H, 140, 13, 110, 33, 16), '#0d0e0f');
  fill(ctx, rrect(H, 152, 66, 86, 11, 5), '#b8bec4');
  fill(ctx, rrect(H, 20, 98, 150, 24, 6), '#33373b');
  fill(ctx, rrect(H, 20, 136, 64, 12, 5), '#a3aab1');
  fill(ctx, rrect(H, 16, 162, 358, 312, 16), '#ffffff');
  fill(ctx, rrect(H, 112, 441, 16, 16, 8), '#c4c9ce');
  fill(ctx, rrect(H, 136, 443, 146, 12, 5), '#b1b8be');
  fill(ctx, rrect(H, 16, 490, 358, 100, 12), '#ffffff');
  fill(ctx, rrect(H, 32, 539.5, 342, 1), '#e6e8ea');
  for (const y of [508, 558]) {
    fill(ctx, rrect(H, 32, y, 72, 14, 5), '#5a6067');
    fill(ctx, rrect(H, 270, y, 88, 14, 5), '#a3aab1');
  }
  fill(ctx, rrect(H, 128, 812, 134, 5, 2.5), '#131416');

  // QR 모듈: 가로로 이어진 칸을 한 사각형으로 (칸 사이 틈이 생기지 않게 조금 겹친다)
  const n = q.getModuleCount();
  const m = QR.s / n;
  const e = 0.25;
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!q.isDark(r, c)) continue;
      let c2 = c;
      while (c2 + 1 < n && q.isDark(r, c2 + 1)) c2++;
      fill(ctx, rrect(H, QR.x + c * m - e, QR.y + r * m - e, (c2 - c + 1) * m + 2 * e, m + 2 * e), '#131416');
      c = c2;
    }
  }

  // 초점·손떨림: 살짝 흐리게
  const out = document.createElement('canvas');
  out.width = W; out.height = H0;
  const o = out.getContext('2d', { willReadFrequently: true });
  o.filter = 'blur(1.1px)';
  o.drawImage(raw, 0, 0);
  return out;
}

export const SCAN_FRAMES = 3; // 한 번에 못 읽으면 다음 프레임을 읽는다 (실제 카메라도 연속 프레임을 읽음)

/** 사진 픽셀에서 QR을 읽는다. 못 읽으면 text가 null */
export function decodeFrame(canvas) {
  if (!canvas || typeof globalThis.jsQR !== 'function') return { text: null, ms: 0 };
  const t0 = performance.now();
  const img = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  const r = globalThis.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
  return { text: r ? r.data : null, ms: performance.now() - t0, version: r?.version };
}
