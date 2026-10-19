// 검증자(행안부 검증앱 역할) 로직: 판매 거래에 묶인 1회용 요청 발행 → 제시물 검증 → 영수증 v2 발급 → 공통기반 원장 기록.
import { randomId, b64uJson } from './jose.js';
import { verifyPresentation } from './sdjwt.js';
import { issueReceiptV2, posTxHash, TD_TYPE } from './receipt2.js';

export { posTxHash, TD_TYPE };

export const AGE_CLAIM = 'not_youth';
export const DEFAULT_PURPOSE = 'LIQUOR';
export const PURPOSE_LABELS = { LIQUOR: '주류 판매 연령 확인', TOBACCO: '담배 판매 연령 확인' };

// 1회용 nonce 저장소. 상태를 plain object로 들고 있어 localStorage에 그대로 저장할 수 있다.
// 판매 거래 정보(td)도 nonce와 함께 매장 쪽에 둔다: 손님이 고를 수 있는 값이 아니다.
export class NonceRegistry {
  constructor(state = {}, ttlSec = 120) {
    this.state = state; // nonce -> { exp, used, td }
    this.ttlSec = ttlSec;
  }
  issue(now = Date.now(), td) {
    const nonce = randomId(12);
    this.state[nonce] = { exp: Math.floor(now / 1000) + this.ttlSec, used: false, ...(td ? { td } : {}) };
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
  tdFor(nonce) {
    return this.state[nonce]?.td;
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

/** 거래 데이터(td) 객체를 만든다. 요청에는 이 객체의 base64url JSON 문자열이 들어간다 */
export async function makeTd({ storeId, purpose = DEFAULT_PURPOSE, posTxId, storeSalt = '', now = Date.now() }) {
  return { type: TD_TYPE, store: storeId, purpose, pos_tx_hash: await posTxHash(posTxId, storeSalt), req_at: Math.floor(now / 1000) };
}

/**
 * 판매 한 건에 묶인 검증 요청(QR 내용). transaction_data는 OpenID4VP 1.0 §5.1처럼 base64url JSON 문자열의 배열이다.
 * posTxId(거래번호)와 storeSalt는 QR에 들어가지 않는다.
 */
export async function createRequest(registry, { storeId, storeName, purpose = DEFAULT_PURPOSE, posTxId = `POS-${randomId(6)}`, storeSalt = '', now = Date.now() }) {
  const td = b64uJson(await makeTd({ storeId, purpose, posTxId, storeSalt, now }));
  const nonce = registry.issue(now, td);
  // exp: 손님 앱이 QR을 읽고 유효시간을 보여 줄 수 있게 요청에도 넣는다 (판정은 매장 쪽 nonce 저장소가 한다)
  return { t: 'vreq', v: 2, nonce, exp: registry.state[nonce].exp, aud: storeId, store: storeName, purpose, claims: [AGE_CLAIM], transaction_data: [td] };
}

export function parseRequest(text) {
  const r = typeof text === 'string' ? JSON.parse(text) : text;
  if (r.t !== 'vreq' || !r.nonce || !r.aud || !Array.isArray(r.claims)) throw new Error('검증 요청 형식이 아닙니다');
  return r;
}

/**
 * 매장 검증 1회: 검증 성공 시 nonce 소모 + 영수증 v2 발급(+ 공통기반 원장 기록).
 * 실패(서명·해시·nonce·거래 결합 등) 시 영수증을 만들지 않는다.
 */
export async function verifyAtStore(vp, { issuerJwk, issuerKeys, registry, store, ledger = null, now = Date.now() }) {
  const report = await verifyPresentation(vp, {
    issuerJwk,
    issuerKeys,
    expectedAud: store.id,
    requiredClaims: [AGE_CLAIM],
    nonceCheck: (n) => registry.check(n, now),
    expectedTd: (n) => registry.tdFor(n),
    now,
  });
  const none = { report, result: null, receipt: null, anchor: null };
  if (!report.ok) return none;
  if (report.discarded.length) {
    // 요청하지 않은 항목이 들어온 제시물은 영수증에 넣지 않는다(개인정보 혼입)
    report.ok = false;
    report.failed = 'claim';
    report.reason = `요청하지 않은 항목(${report.discarded.join(', ')})이 들어 있습니다`;
    return none;
  }
  const nonce = report.kb.nonce;
  const td = registry.tdFor(nonce);
  registry.consume(nonce);
  const result = report.claims[AGE_CLAIM] === true ? 'Y' : 'N';
  const t = performance.now();
  const receipt = await issueReceiptV2({ vp, nonce, td, result }, { storeJwk: store.jwk, storeCert: store.cert, storeId: store.id, now });
  report.timings.receipt = performance.now() - t;
  report.timings.total += report.timings.receipt;
  const anchor = ledger ? await ledger.anchor(receipt, now) : null;
  return { report, result, receipt, anchor };
}
