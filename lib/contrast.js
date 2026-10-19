// WCAG 2.x 대비 비율. 큰 글씨 모드 색을 정하고 README 표를 만들 때 쓴다 (순수 함수).

/** '#rrggbb' 또는 '#rgb' → [r, g, b] (0~255) */
export function parseHex(hex) {
  const h = String(hex).trim().replace(/^#/, '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`색 형식이 아니에요: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

/** 상대 휘도 (WCAG 2.x 정의) */
export function luminance(hex) {
  const [r, g, b] = parseHex(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** 대비 비율 (1~21). 소수 둘째 자리에서 내림해 기준을 넘는다고 부풀리지 않는다 */
export function contrastRatio(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return Math.floor(((a + 0.05) / (b + 0.05)) * 100) / 100;
}

// 큰 글씨 모드에서 실제로 쓰는 전경/배경 쌍 (phone.css html.large 규칙과 같은 값, 모두 KRDS 색 단계)
export const LARGE_PAIRS = [
  { use: '본문·제목·핵심 문장', fg: '#131416', bg: '#ffffff', token: 'gray-95 / gray-0' },
  { use: '본문 (회색 바탕 화면·시트)', fg: '#131416', bg: '#f4f5f6', token: 'gray-95 / gray-5' },
  { use: '보조 설명', fg: '#464c53', bg: '#ffffff', token: 'gray-70 / gray-0' },
  { use: '보조 설명 (회색 바탕)', fg: '#464c53', bg: '#f4f5f6', token: 'gray-70 / gray-5' },
  { use: '[보내기] 버튼 글자', fg: '#ffffff', bg: '#083891', token: 'gray-0 / primary-70' },
  { use: '[취소] 텍스트 링크', fg: '#083891', bg: '#f4f5f6', token: 'primary-70 / gray-5' },
  { use: '카메라 안내 문구', fg: '#ffffff', bg: '#131416', token: 'gray-0 / gray-95' },
  { use: '배지 「보냄」·「저장됨」 (두 폰)', fg: '#1f4727', bg: '#eaf6ec', token: 'success-80 / success-5' },
  { use: '매장 결과 문구 (성공)', fg: '#131416', bg: '#f4f5f6', token: 'gray-95 / gray-5' },
  { use: '매장 결과 문구 (실패)', fg: '#8a240f', bg: '#f4f5f6', token: 'danger-70 / gray-5' },
];

/** 큰 글씨 모드 목표: 본문 대비 7:1 (WCAG AAA) */
export const LARGE_TARGET = 7;
