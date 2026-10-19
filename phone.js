// iframe 안의 폰 한 대. 바깥 페이지(app.js)가 보낸 Ionic 화면 마크업을 그리고,
// 화면 안 버튼 누름·키보드를 바깥으로 돌려보낸다. 서명·검증은 하지 않는다.
const role = new URLSearchParams(location.search).get('role') || 'customer';
document.documentElement.dataset.role = role;
const app = document.getElementById('app');
let shownHtml = '';
let shownLarge = null;
const parentOrigin = location.origin;
const post = (msg) => parent.postMessage({ ...msg, role }, parentOrigin);

async function ionReady() {
  if (window.customElements) await customElements.whenDefined('ion-app');
}

// 바텀시트처럼 배열·숫자 속성이 필요한 컴포넌트는 data-*로 받아 속성으로 넣는다
async function hydrate(root) {
  const modals = [...root.querySelectorAll('ion-modal[data-sheet]')];
  await Promise.all(modals.map(async (m) => {
    await customElements.whenDefined('ion-modal');
    // Ionic 「높이 자동 바텀시트」: 시트가 내용 높이만큼 올라오고, 아래로 끌어도 닫히지 않는다
    m.breakpoints = [0, 1];
    m.initialBreakpoint = 1;
    m.backdropBreakpoint = 0;
    m.backdropDismiss = false;
    m.canDismiss = false;
    m.handle = true;
    m.isOpen = true;
  }));
  const els = [...root.querySelectorAll('*')].filter((e) => e.tagName.startsWith('ION-') && e.componentOnReady);
  await Promise.all(els.map((e) => e.componentOnReady()));
  if (modals.length) {
    await Promise.all(modals.map((m) => new Promise((r) => {
      m.addEventListener('ionModalDidPresent', r, { once: true });
      setTimeout(r, 1200);
    })));
  }
}

async function show({ html, time, frame, seq, large }) {
  document.getElementById('time').textContent = time || '';
  document.documentElement.classList.toggle('frameless', !frame);
  // 큰 글씨 모드: 글자·버튼 크기가 바뀌면 높이 자동 바텀시트도 다시 재야 해서 화면을 새로 그린다
  const largeChanged = !!large !== shownLarge;
  document.documentElement.classList.toggle('large', !!large);
  shownLarge = !!large;
  if (html !== shownHtml || largeChanged) {
    shownHtml = html;
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    // 같은 카메라 화면에서 인식 상태만 바뀌면 다시 그리지 않고 상태·안내만 바꾼다 (사진·스캔 라인이 깜박이지 않게)
    const cam = app.querySelector('.cam[data-key]');
    const nextCam = tpl.content.querySelector('.cam[data-key]');
    if (!largeChanged && cam && nextCam && cam.dataset.key === nextCam.dataset.key) {
      cam.dataset.state = nextCam.dataset.state;
      cam.querySelector('.cam-status').innerHTML = nextCam.querySelector('.cam-status').innerHTML;
    } else {
      document.body.classList.remove('backdrop-no-scroll');
      app.replaceChildren(tpl.content);
      await hydrate(app);
    }
    // 카메라처럼 어두운 화면에서는 상태 표시줄·홈 막대를 흰색으로
    document.documentElement.classList.toggle('status-light', !!app.querySelector('[data-statusbar="light"]'));
  }
  post({ type: 'rendered', seq });
}

window.addEventListener('message', (e) => {
  if (e.origin !== parentOrigin || e.source !== parent) return;
  if (e.data?.type === 'ping') ionReady().then(() => post({ type: 'hello' }));
  if (e.data?.type === 'screen') ionReady().then(() => show(e.data)).catch((err) => console.error(err));
});

app.addEventListener('click', (e) => {
  const t = e.target.closest('[data-act]');
  if (t && !t.hasAttribute('disabled') && t.dataset.act) post({ type: 'act', act: t.dataset.act });
});
document.addEventListener('keydown', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Escape'].includes(e.key)) post({ type: 'key', key: e.key });
});

ionReady().then(() => post({ type: 'hello' }));
