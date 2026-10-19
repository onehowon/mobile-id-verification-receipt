// 손님 앱이 매장 QR을 찍는 단계. DOM이 없는 순수 함수라 Node 테스트로 확인한다.
// - matchScannedRequest: QR에서 읽은 글자가 매장이 방금 띄운 요청과 같은지(1회용 번호 포함) 확인
// - homography/project: 카메라 화면 연출용 원근 변환(평면 네 점 → 사진 네 점)

const FIELDS = ['t', 'v', 'nonce', 'exp', 'aud', 'store', 'purpose', 'claims', 'transaction_data'];

/** QR에서 읽은 글자 → { ok, req, reason }. 매장이 띄운 요청(expected)과 모든 필드가 같고 유효시간 안이어야 ok */
export function matchScannedRequest(text, expected, { now = Date.now() } = {}) {
  if (typeof text !== 'string' || !text) return { ok: false, reason: 'QR을 읽지 못했어요' };
  let req;
  try { req = JSON.parse(text); } catch { return { ok: false, reason: '검증 요청 형식이 아니에요' }; }
  if (!req || typeof req !== 'object' || req.t !== 'vreq') return { ok: false, req, reason: '검증 요청 형식이 아니에요' };
  if (req.nonce !== expected.nonce) return { ok: false, req, reason: '매장이 띄운 요청과 1회용 번호가 달라요' };
  if (req.aud !== expected.aud) return { ok: false, req, reason: '다른 매장의 요청이에요' };
  if (JSON.stringify(req.claims) !== JSON.stringify(expected.claims)) return { ok: false, req, reason: '확인 항목이 달라요' };
  if (FIELDS.some((k) => JSON.stringify(req[k]) !== JSON.stringify(expected[k]))) return { ok: false, req, reason: '요청 내용이 달라요' };
  if (typeof req.exp !== 'number' || req.exp * 1000 < now) return { ok: false, req, reason: '유효시간이 지난 요청이에요' };
  return { ok: true, req };
}

/** 네 점 대응으로 3×3 원근 변환 행렬을 구한다 (h33 = 1) */
export function homography(src, dst) {
  const A = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // 가우스 소거 (부분 피벗)
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  const h = A.map((row, i) => row[8] / row[i]);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

export function project(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
