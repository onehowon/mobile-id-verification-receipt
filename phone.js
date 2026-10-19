// iframe 안의 폰 한 대. 바깥 페이지(app.js)가 보낸 Ionic 화면 마크업을 그리고,
// 화면 안 버튼 누름·키보드를 바깥으로 돌려보낸다. 서명·검증은 하지 않는다.
const role = new URLSearchParams(location.search).get('role') || 'customer';
document.documentElement.dataset.role = role;
const app = document.getElementById('app');
let shownHtml = '';
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

async function show({ html, time, frame, seq }) {
  document.getElementById('time').textContent = time || '';
  document.documentElement.classList.toggle('frameless', !frame);
  if (html !== shownHtml) {
    shownHtml = html;
    document.body.classList.remove('backdrop-no-scroll');
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    app.replaceChildren(tpl.content);
    await hydrate(app);
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
