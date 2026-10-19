// 위조 시연용 공격 생성기. 모두 "공격자가 할 수 있는 일"만 한다(발급기관·손님 개인키는 쓰지 않음).
// 손님 쪽 공격(장면 ②)과 업주 쪽 공격(영수증 위조, 장면 ③)이 있다. 업주는 매장 키를 가지고 있다고 본다.
import { generateKeyJwk, decodeJws, signJws, randomId, b64uJson } from './jose.js';
import { parseSdJwt, decodeDisclosure, makeDisclosure, issueAgeBatch, createPresentation } from './sdjwt.js';
import { issueReceiptV2, posTxHash, TD_TYPE } from './receipt2.js';

export const ATTACKS = {
  birth: {
    title: '생년·연령 변조',
    desc: '미성년자의 제시물에서 공개 항목 값을 「청소년 아님 = 예」로 고쳐 쓴다. 화면 캡처의 생년월일을 고치는 것과 같은 공격.',
    expect: 'disclosure',
  },
  forge: {
    title: '서명 위조 (가짜 신분증 앱)',
    desc: '위조 앱이 자기 키로 「청소년 아님」 증명을 만들어 매장 요청에 맞춰 제시한다. 형식·홀더 서명·nonce·거래 결합은 모두 정상이지만 발급기관 키가 다르다.',
    expect: 'issuer_sig',
  },
  replay: {
    title: '재사용 nonce (캡처 QR 재제시)',
    desc: '다른 사람이 이미 한 번 쓴 QR을 캡처해 다시 보여준다.',
    expect: 'nonce',
  },
  stolen: {
    title: '탈취한 자격증명 (홀더 키 없음)',
    desc: '남의 자격증명을 복사해 새 요청에 맞춰 자기 키로 서명한다.',
    expect: 'holder_binding',
  },
};

/** 미성년자 제시물의 not_youth 공개값을 true로 바꾼다(같은 salt 유지). KB-JWT는 그대로 둔다. */
export function tamperBirth(vp) {
  const { issuerJwt, disclosures, kbJwt } = parseSdJwt(vp);
  const forged = disclosures.map((d) => {
    const { salt, name } = decodeDisclosure(d);
    if (name === 'not_youth') return makeDisclosure(name, true, salt);
    if (name === 'birthdate') return makeDisclosure(name, '2000-01-01', salt);
    return d;
  });
  return `${issuerJwt}~${forged.map((d) => d + '~').join('')}${kbJwt}`;
}

/** 위조 발급기관 키로 만든 「청소년 아님」 증명과 그 제시물. 발급기관 id·kid는 진짜처럼 흉내 낸다. */
async function fakeAgeVp({ issuer, nonce, aud, now, transactionData }) {
  const fakeIssuer = { id: issuer.id, kid: issuer.kid, jwk: await generateKeyJwk() };
  const [{ sdjwt, holderJwk }] = await issueAgeBatch({ birthdate: '1990-01-01' }, { issuer: fakeIssuer, count: 1, now });
  return createPresentation(sdjwt, { disclose: ['not_youth'], nonce, aud, holderJwk, now, transactionData });
}

/** 위조 앱: 매장 요청(nonce·거래 데이터)에 맞춰 자기 키로 서명한 제시물 */
export async function forgeWithFakeIssuer({ issuer, request, nonce = request?.nonce, aud = request?.aud, now = Date.now() }) {
  return fakeAgeVp({ issuer, nonce, aud, now, transactionData: request?.transaction_data });
}

/** 남의 제시물에서 발급기관 JWT·공개 항목을 떼어 와 공격자 키로 KB-JWT를 만든다. */
export async function stealAndRebind(victimVp, { nonce, aud, now = Date.now(), transactionData }) {
  const { issuerJwt, disclosures } = parseSdJwt(victimVp);
  const sdjwt = `${issuerJwt}~${disclosures.map((d) => d + '~').join('')}`;
  return createPresentation(sdjwt, { disclose: disclosures.map((d) => decodeDisclosure(d).name), nonce, aud, holderJwk: await generateKeyJwk(), now, transactionData });
}

export function describeVp(vp) {
  const { issuerJwt, disclosures, kbJwt } = parseSdJwt(vp);
  return {
    issuer: decodeJws(issuerJwt).payload,
    disclosures: disclosures.map(decodeDisclosure),
    kb: kbJwt ? decodeJws(kbJwt).payload : null,
  };
}

// ---------- 업주 공격: 매장 키를 가진 업주가 단속에 낼 영수증을 꾸민다 ----------

export const OWNER_ATTACKS = {
  noVp: { title: '매장 키로만 서명한 영수증', expect: 'format' },
  fakeIssuer: { title: '업주가 만든 가짜 증명을 넣은 영수증', expect: 'issuer_sig' },
  flip: { title: '미성년 N 영수증을 Y로 고쳐 재서명', expect: 'result' },
  backdate: { title: '시각을 앞당겨 재서명', expect: 'time' },
  crossStore: { title: '다른 매장 제시물을 끼워 넣은 영수증', expect: 'audience' },
};

async function tdFor(store, posTxId, now, purpose = 'LIQUOR') {
  return b64uJson({ type: TD_TYPE, store: store.id, purpose, pos_tx_hash: await posTxHash(posTxId, store.salt || ''), req_at: Math.floor(now / 1000) });
}

/** 손님 제시물 없이 매장 키로만 서명한 「Y」 영수증 (v1 방식의 자가 발급) */
export async function ownerForgeNoVp(store, { posTxId, now = Date.now() }) {
  const iat = Math.floor(now / 1000);
  const td = await tdFor(store, posTxId, now);
  return signJws({ typ: 'vreceipt+jwt;v=2', scert: store.cert }, {
    ver: 2, rid: randomId(9), result: 'Y', claim: 'not_youth', purpose: 'LIQUOR', store: store.id, iat, exp: iat + 90 * 86400, nonce: randomId(12), td,
  }, store.jwk);
}

/** 업주가 가짜 발급기관 키·가짜 손님 키로 증명과 제시물을 직접 만들어 넣은 「Y」 영수증 */
export async function ownerForgeFakeIssuer(store, { issuer, posTxId, now = Date.now() }) {
  const td = await tdFor(store, posTxId, now);
  const nonce = randomId(12);
  const vp = await fakeAgeVp({ issuer, nonce, aud: store.id, now, transactionData: [td] });
  return issueReceiptV2({ vp, nonce, td, result: 'Y' }, { storeJwk: store.jwk, storeCert: store.cert, storeId: store.id, now });
}

/** 영수증 본문을 고쳐 매장 키로 다시 서명 */
export async function ownerResign(receipt, store, change) {
  const d = decodeJws(receipt);
  return signJws({ ...d.header }, { ...d.payload, ...change(d.payload) }, store.jwk);
}

/** 미성년 손님에게 받은 N 영수증을 Y로 고쳐 재서명 */
export const ownerFlipResult = (receiptN, store) => ownerResign(receiptN, store, () => ({ result: 'Y' }));

/** 영수증 시각을 deltaSec만큼 옮겨 재서명 (예: −3시간) */
export const ownerBackdate = (receipt, store, deltaSec) => ownerResign(receipt, store, (p) => ({ iat: p.iat + deltaSec, exp: p.exp + deltaSec }));

/** 다른 매장(B) 앞으로 만든 제시물을 A매장 영수증에 넣는다 */
export async function crossStore(vpForB, storeA, { posTxId, now = Date.now() }) {
  const kb = decodeJws(parseSdJwt(vpForB).kbJwt).payload;
  const td = await tdFor(storeA, posTxId, now);
  return issueReceiptV2({ vp: vpForB, nonce: kb.nonce, td, result: 'Y' }, { storeJwk: storeA.jwk, storeCert: storeA.cert, storeId: storeA.id, now });
}
