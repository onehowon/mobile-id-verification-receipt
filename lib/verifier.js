// 검증자(행안부 검증앱 역할) 로직: 1회용 요청 발행 → 제시물 검증 → 영수증 발급.
import { randomId } from './jose.js';
import { verifyPresentation } from './sdjwt.js';
import { issueReceipt } from './receipt.js';

export const AGE_CLAIM = 'age_over_19';
export const DEFAULT_PURPOSE = '주류 판매 연령 확인';

// 1회용 nonce 저장소. 상태를 plain object로 들고 있어 localStorage에 그대로 저장할 수 있다.
export class NonceRegistry {
  constructor(state = {}, ttlSec = 120) {
    this.state = state; // nonce -> { exp, used }
    this.ttlSec = ttlSec;
  }
  issue(now = Date.now()) {
    const nonce = randomId(12);
    this.state[nonce] = { exp: Math.floor(now / 1000) + this.ttlSec, used: false };
    this.prune(now);
    return nonce;
  }
  check(nonce, now = Date.now()) {
    const e = this.state[nonce];
    if (!e) return 'unknown';
    if (e.used) return 'used';
    if (e.exp < Math.floor(now / 1000)) return 'expired';
    return 'ok';
  }
  consume(nonce) {
    if (this.state[nonce]) this.state[nonce].used = true;
  }
  prune(now = Date.now()) {
    // 사용된 nonce는 재사용 탐지를 위해 하루 보관
    const limit = Math.floor(now / 1000) - 86400;
    for (const [k, v] of Object.entries(this.state)) if (v.exp < limit) delete this.state[k];
  }
}

export function createRequest(registry, { storeId, storeName, purpose = DEFAULT_PURPOSE, now = Date.now() }) {
  const nonce = registry.issue(now);
  // exp: 손님 앱이 QR을 읽고 유효시간을 보여 줄 수 있게 요청에도 넣는다 (판정은 매장 쪽 nonce 저장소가 한다)
  return { t: 'vreq', v: 1, nonce, exp: registry.state[nonce].exp, aud: storeId, store: storeName, purpose, claims: [AGE_CLAIM] };
}

export function parseRequest(text) {
  const r = typeof text === 'string' ? JSON.parse(text) : text;
  if (r.t !== 'vreq' || !r.nonce || !r.aud || !Array.isArray(r.claims)) throw new Error('검증 요청 형식이 아닙니다');
  return r;
}

/**
 * 매장 검증 1회: 검증 성공 시 nonce 소모 + 영수증 발급.
 * 실패(서명·해시·nonce 등) 시 영수증을 만들지 않는다.
 */
export async function verifyAtStore(vp, { issuerJwk, registry, store, now = Date.now(), purpose = DEFAULT_PURPOSE }) {
  const report = await verifyPresentation(vp, {
    issuerJwk,
    expectedAud: store.id,
    requiredClaims: [AGE_CLAIM],
    nonceCheck: (n) => registry.check(n, now),
    now,
  });
  if (!report.ok) return { report, result: null, receipt: null };
  registry.consume(report.kb.nonce);
  const result = report.claims[AGE_CLAIM] === true ? 'Y' : 'N';
  const t = performance.now();
  const receipt = await issueReceipt(
    { vp, result, claim: AGE_CLAIM, purpose, storeId: store.id },
    { storeJwk: store.jwk, storeCert: store.cert, now },
  );
  report.timings.receipt = performance.now() - t;
  report.timings.total += report.timings.receipt;
  return { report, result, receipt };
}
