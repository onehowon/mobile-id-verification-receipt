// 시연 장면이 쓰는 실제 흐름. DOM 없이 lib 모듈만 호출하므로 Node 테스트에서도 그대로 돈다.
// 화면은 이 함수들의 결과(제시물, 검증 보고서, 영수증)를 그릴 뿐, 결과를 꾸며내지 않는다.
import { generateKeyJwk } from './jose.js';
import { ISSUER, REGISTRY } from './demo-keys.js';
import { issueCredential, createPresentation, readCredential } from './sdjwt.js';
import { NonceRegistry, createRequest, verifyAtStore } from './verifier.js';
import { createStoreCert, verifyReceipt } from './receipt.js';
import { tamperBirth, forgeWithFakeIssuer } from './tamper.js';
import { createSealedCopy, verifySealedCopy } from './sealed.js';
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

/** 발급기관·매장 준비: 손님 두 명(성인/미성년)의 자격증명과 등록기관이 서명한 매장 인증서 */
export async function setupDemo({ now = Date.now() } = {}) {
  const adultKey = await generateKeyJwk();
  const minorKey = await generateKeyJwk();
  const storeJwk = await generateKeyJwk();
  const adult = await issueCredential(PEOPLE.adult, { issuer: ISSUER, holderJwk: adultKey, now });
  const minor = await issueCredential(PEOPLE.minor, { issuer: ISSUER, holderJwk: minorKey, now });
  const cert = await createStoreCert({ storeId: STORE.id, storeName: STORE.name, storeJwk }, REGISTRY, { now });
  return {
    adult: { key: adultKey, sdjwt: adult.sdjwt, claims: readCredential(adult.sdjwt).claims },
    minor: { key: minorKey, sdjwt: minor.sdjwt, claims: readCredential(minor.sdjwt).claims },
    store: { ...STORE, jwk: storeJwk, cert },
    registry: new NonceRegistry(),
    measures: [],
  };
}

export function newRequest(ctx, { now = Date.now() } = {}) {
  return createRequest(ctx.registry, { storeId: ctx.store.id, storeName: ctx.store.name, now });
}

function record(ctx, scenario, out, now) {
  ctx.measures.push(toRow({ scenario, outcome: out.report.ok ? out.result : 'fail', report: out.report, at: now, ua: globalThis.navigator?.userAgent || 'node' }));
}

/** 장면 ①: 매장 요청 → 손님이 「만 19세 이상」만 골라 서명 → 매장 검증 + 영수증 */
export async function runAdultCheck(ctx, { now = Date.now(), request = newRequest(ctx, { now }) } = {}) {
  const vp = await createPresentation(ctx.adult.sdjwt, {
    disclose: request.claims, nonce: request.nonce, aud: request.aud, holderJwk: ctx.adult.key, now,
  });
  const out = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: ctx.registry, store: ctx.store, now });
  record(ctx, 'adult', out, now);
  const sent = request.claims;
  const withheld = Object.keys(ctx.adult.claims).filter((k) => !sent.includes(k));
  return { request, vp, out, sent, withheld, at: now };
}

export const ATTACK_KINDS = ['birth', 'forge', 'replay'];

/**
 * 장면 ②: 위조 시도. 공격자가 할 수 있는 일만 한다.
 * birth  미성년자의 제시물에서 연령 값을 「예」로 고침
 * forge  위조 앱이 자기 키로 만든 「성인」 신분증
 * replay 다른 사람이 이미 쓴 제시물(QR)을 다시 보여 줌
 */
export async function runAttack(ctx, kind, opts = {}) {
  return verifyAttack(ctx, await prepareAttack(ctx, kind, opts), opts);
}

/** 위조물만 만든다(손님 폰에 띄울 QR). 검증은 verifyAttack에서 */
export async function prepareAttack(ctx, kind, { now = Date.now(), usedVp } = {}) {
  const request = newRequest(ctx, { now });
  let vp;
  if (kind === 'birth') {
    const honest = await createPresentation(ctx.minor.sdjwt, {
      disclose: request.claims, nonce: request.nonce, aud: request.aud, holderJwk: ctx.minor.key, now,
    });
    vp = tamperBirth(honest);
  } else if (kind === 'forge') {
    vp = await forgeWithFakeIssuer({ issuer: ISSUER, nonce: request.nonce, aud: request.aud, now });
  } else if (kind === 'replay') {
    if (!usedVp) throw new Error('재사용할 제시물이 없습니다');
    vp = usedVp;
  } else {
    throw new Error(`알 수 없는 공격: ${kind}`);
  }
  return { kind, request, vp };
}

export async function verifyAttack(ctx, prepared, { now = Date.now() } = {}) {
  const out = await verifyAtStore(prepared.vp, { issuerJwk: ISSUER.jwk, registry: ctx.registry, store: ctx.store, now });
  record(ctx, `attack:${prepared.kind}`, out, now);
  return { ...prepared, out, at: now };
}

/** 장면 ③: 약 3개월 뒤 구청이 영수증을 검증 */
export async function runAudit(receipt, { issuedAt, afterDays = AUDIT_AFTER_DAYS } = {}) {
  const at = issuedAt + afterDays * DAY_MS;
  const report = await verifyReceipt(receipt, { registryJwk: REGISTRY.jwk, now: at });
  return { report, at };
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
  const { token, jti } = await createSealedCopy(ctx.adult.sdjwt, {
    disclose: ['name', 'birthdate'], recipient: AGENCY.id, purpose: '민원 신청 본인 확인', expiresAt, holderJwk: ctx.adult.key, now,
  });
  const valid = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient: AGENCY.id, now: now + DAY_MS });
  const expired = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient: AGENCY.id, now: expiresAt + DAY_MS });
  return { token, jti, expiresAt, valid, expired, at: now };
}
