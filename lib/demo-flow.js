// 시연 장면이 쓰는 실제 흐름. DOM 없이 lib 모듈만 호출하므로 Node 테스트에서도 그대로 돈다.
// 화면은 이 함수들의 결과(제시물, 검증 보고서, 영수증)를 그릴 뿐, 결과를 꾸며내지 않는다.
import { generateKeyJwk, randomId } from './jose.js';
import { ISSUER, ISSUER_KEYS, REGISTRY, LEDGER } from './demo-keys.js';
import { issueCredential, issueAgeBatch, AgeWallet, readCredential } from './sdjwt.js';
import { NonceRegistry, createRequest, verifyAtStore } from './verifier.js';
import { createStoreCert } from './receipt.js';
import { VerificationLedger, verifyReceiptV2 } from './receipt2.js';
import { tamperBirth, forgeWithFakeIssuer, ownerForgeFakeIssuer, ownerFlipResult } from './tamper.js';
import { createSealedCopy, verifySealedCopy } from './sealed.js';
import { notYouth } from './age.js';
import { toRow, summarize } from './measure.js';

export const DAY_MS = 86400000;
export const STORE = { id: 'STORE-DEMO-0001', name: '가상 주점' };
export const AGENCY = { id: 'GOV-DEMO-0001', name: '가상 구청 민원실' };
export const PEOPLE = {
  adult: { name: '김하나', birthdate: '1998-03-14' },
  minor: { name: '이준', birthdate: '2009-05-02' },
};
export const AUDIT_AFTER_DAYS = 85; // 약 3개월 뒤 단속 (보관 기한 90일 안)
export const SEALED_DAYS = 7;
export const BATCH_SIZE = 30; // 1회용 연령 증명 묶음 크기

async function person(p, now) {
  const idKey = await generateKeyJwk();
  // 신분증 자격증명(이름·생년월일): 봉인 사본에만 쓴다
  const id = await issueCredential(p, { issuer: ISSUER, holderJwk: idKey, now });
  // 연령 전용 1회용 증명 묶음: not_youth 하나만 담고, 장마다 키·salt가 다르다
  const wallet = new AgeWallet(await issueAgeBatch(p, { issuer: ISSUER, count: BATCH_SIZE, now }));
  return { idKey, idCred: id.sdjwt, claims: readCredential(id.sdjwt).claims, notYouth: notYouth(p.birthdate, now), wallet, birthdate: p.birthdate };
}

/** 발급기관·매장·공통기반 준비: 손님 두 명(청소년 아님 / 청소년), 등록기관이 서명한 매장 인증서, 검증 사실 원장 */
export async function setupDemo({ now = Date.now() } = {}) {
  const storeJwk = await generateKeyJwk();
  const cert = await createStoreCert({ storeId: STORE.id, storeName: STORE.name, storeJwk }, REGISTRY, { now });
  return {
    adult: await person(PEOPLE.adult, now),
    minor: await person(PEOPLE.minor, now),
    // salt: 거래번호 해시용 매장 비밀값. seq: 판매 일련번호
    store: { ...STORE, jwk: storeJwk, cert, salt: randomId(12), seq: 41 },
    registry: new NonceRegistry(),
    ledger: new VerificationLedger(LEDGER),
    sales: {}, // nonce -> 거래번호 (매장 안에서만)
    receipts: [], // 매장 검증앱이 보관하는 영수증 (단속 때 1회용 증명 돌려쓰기 확인에 쓴다)
    measures: [],
  };
}

/** 판매 한 건 = 거래번호 하나 + 그 거래에 묶인 1회용 요청 */
export async function newRequest(ctx, { now = Date.now() } = {}) {
  const d = new Date(now + 9 * 3600000).toISOString().slice(0, 10).replaceAll('-', '');
  const posTxId = `POS-${d}-${String(++ctx.store.seq).padStart(4, '0')}`;
  const request = await createRequest(ctx.registry, { storeId: ctx.store.id, storeName: ctx.store.name, posTxId, storeSalt: ctx.store.salt, now });
  ctx.sales[request.nonce] = posTxId;
  return request;
}

function record(ctx, scenario, out, now) {
  ctx.measures.push(toRow({ scenario, outcome: out.report.ok ? out.result : 'fail', report: out.report, at: now, ua: globalThis.navigator?.userAgent || 'node' }));
}

async function present(ctx, who, request, now) {
  const p = ctx[who];
  if (!p.wallet.remaining) p.wallet.add(await issueAgeBatch(p, { issuer: ISSUER, count: BATCH_SIZE, now })); // 묶음 재충전
  return p.wallet.present(request, { now });
}

async function storeVerify(ctx, vp, now) {
  const out = await verifyAtStore(vp, { issuerKeys: ISSUER_KEYS, registry: ctx.registry, store: ctx.store, ledger: ctx.ledger, now });
  if (out.receipt) ctx.receipts.push(out.receipt);
  return out;
}

/** 장면 ①: 매장 요청(판매 1건) → 손님 지갑이 1회용 증명으로 「청소년 아님」만 서명 → 매장 검증 + 영수증 + 원장 기록 */
export async function runAdultCheck(ctx, { now = Date.now(), request, who = 'adult' } = {}) {
  request = request || await newRequest(ctx, { now });
  const vp = await present(ctx, who, request, now);
  const out = await storeVerify(ctx, vp, now);
  record(ctx, who, out, now);
  const sent = request.claims;
  const withheld = Object.keys(ctx[who].claims).filter((k) => !sent.includes(k));
  return { request, posTxId: ctx.sales[request.nonce], vp, out, sent, withheld, at: now };
}

export const ATTACK_KINDS = ['birth', 'forge', 'replay'];

/**
 * 장면 ②: 위조 시도. 공격자가 할 수 있는 일만 한다.
 * birth  청소년의 제시물에서 연령 값을 「예」로 고침
 * forge  위조 앱이 자기 키로 만든 「청소년 아님」 증명
 * replay 다른 사람이 이미 쓴 제시물(QR)을 다시 보여 줌
 */
export async function runAttack(ctx, kind, opts = {}) {
  return verifyAttack(ctx, await prepareAttack(ctx, kind, opts), opts);
}

/** 위조물만 만든다(손님 폰에 띄울 QR). 검증은 verifyAttack에서 */
export async function prepareAttack(ctx, kind, { now = Date.now(), usedVp } = {}) {
  const request = await newRequest(ctx, { now });
  let vp;
  if (kind === 'birth') {
    vp = tamperBirth(await present(ctx, 'minor', request, now));
  } else if (kind === 'forge') {
    vp = await forgeWithFakeIssuer({ issuer: ISSUER, request, now });
  } else if (kind === 'replay') {
    if (!usedVp) throw new Error('재사용할 제시물이 없습니다');
    vp = usedVp;
  } else {
    throw new Error(`알 수 없는 공격: ${kind}`);
  }
  return { kind, request, vp };
}

export async function verifyAttack(ctx, prepared, { now = Date.now() } = {}) {
  const out = await storeVerify(ctx, prepared.vp, now);
  record(ctx, `attack:${prepared.kind}`, out, now);
  return { ...prepared, out, at: now };
}

/** 구청 재검증: 공개키(발급기관·등록기관·공통기반)와 업주가 낸 거래번호만으로 서버 조회 없이 검사 */
export function auditReceipt(ctx, receipt, { anchor, posTxId, at }) {
  return verifyReceiptV2(receipt, {
    issuerKeys: ISSUER_KEYS, registryJwk: REGISTRY.jwk, ledgerJwk: LEDGER.jwk, anchor, ledger: ctx.ledger,
    revokedStores: ctx.ledger.revoked, posTxId, storeSalt: ctx.store.salt, others: ctx.receipts, now: at,
  });
}

/** 장면 ③: 약 3개월 뒤 구청이 신고된 판매(거래번호)의 영수증을 검증 */
export async function runAudit(ctx, check, { afterDays = AUDIT_AFTER_DAYS } = {}) {
  const at = check.at + afterDays * DAY_MS;
  const report = await auditReceipt(ctx, check.out.receipt, { anchor: check.out.anchor, posTxId: check.posTxId, at });
  return { report, at, posTxId: check.posTxId };
}

export const OWNER_KINDS = ['fakeIssuer', 'flip'];

/**
 * 장면 ③ 대비: 업주가 매장 키로 영수증을 꾸며 낸다. 원장 기록까지 받아도(업주가 검증앱으로 올렸다고 가정) 통과하지 못한다.
 * fakeIssuer  신고된 판매 거래번호로, 업주가 만든 가짜 증명을 넣은 「Y」 영수증
 * flip        청소년 손님에게 실제로 받은 「N」 영수증을 「Y」로 고쳐 재서명
 */
export async function runOwnerForgery(ctx, check, { afterDays = AUDIT_AFTER_DAYS } = {}) {
  const at = check.at + afterDays * DAY_MS;
  const fakeReceipt = await ownerForgeFakeIssuer(ctx.store, { issuer: ISSUER, posTxId: check.posTxId, now: check.at });
  const fakeAnchor = await ctx.ledger.anchor(fakeReceipt, check.at);
  const minor = await runAdultCheck(ctx, { now: check.at, who: 'minor' });
  const flipReceipt = await ownerFlipResult(minor.out.receipt, ctx.store);
  const flipAnchor = await ctx.ledger.anchor(flipReceipt, check.at);
  return {
    at,
    fakeIssuer: { receipt: fakeReceipt, posTxId: check.posTxId, report: await auditReceipt(ctx, fakeReceipt, { anchor: fakeAnchor, posTxId: check.posTxId, at }) },
    flip: { receipt: flipReceipt, posTxId: minor.posTxId, original: minor.out.result, report: await auditReceipt(ctx, flipReceipt, { anchor: flipAnchor, posTxId: minor.posTxId, at }) },
  };
}

/** 장면 ④: 정상 검증 n회. 검증기 쪽 시간만 잰다. */
export async function runBenchmark(ctx, n = 30) {
  const totals = [];
  for (let i = 0; i < n; i++) {
    const now = Date.now();
    const { out } = await runAdultCheck(ctx, { now });
    ctx.measures[ctx.measures.length - 1].scenario = 'benchmark';
    totals.push(out.report.timings.total);
  }
  return summarize(totals);
}

/** 장면 ⑤: 기관 제출용 봉인 사본. 기한 안·기한 뒤 두 시점으로 검증 */
export async function runSealed(ctx, { now = Date.now(), days = SEALED_DAYS } = {}) {
  const expiresAt = now + days * DAY_MS;
  const { token, jti } = await createSealedCopy(ctx.adult.idCred, {
    disclose: ['name', 'birthdate'], recipient: AGENCY.id, purpose: '민원 신청 본인 확인', expiresAt, holderJwk: ctx.adult.idKey, now,
  });
  const valid = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient: AGENCY.id, now: now + DAY_MS });
  const expired = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient: AGENCY.id, now: expiresAt + DAY_MS });
  return { token, jti, expiresAt, valid, expired, at: now };
}
