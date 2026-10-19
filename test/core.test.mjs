import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyJwk, decodeJws, signJws } from '../lib/jose.js';
import { ISSUER, REGISTRY } from '../lib/demo-keys.js';
import { issueCredential, createPresentation, verifyPresentation, parseSdJwt, decodeDisclosure, ageOn, readCredential } from '../lib/sdjwt.js';
import { NonceRegistry, createRequest, verifyAtStore } from '../lib/verifier.js';
import { createStoreCert, verifyReceipt, RECEIPT_FIELDS } from '../lib/receipt.js';
import { tamperBirth, forgeWithFakeIssuer, stealAndRebind } from '../lib/tamper.js';
import { createSealedCopy, verifySealedCopy } from '../lib/sealed.js';
import { toCsv, toRow, summarize } from '../lib/measure.js';

const NOW = Date.parse('2026-10-19T12:00:00+09:00');
const DAY_MS = 86400000;
const ADULT = { name: '김민준', birthdate: '1995-03-14' };
const MINOR = { name: '이서연', birthdate: '2009-08-02' };

let holderJwk, store, adultCred, minorCred;

before(async () => {
  holderJwk = await generateKeyJwk();
  const storeJwk = await generateKeyJwk();
  store = { id: 'STORE-DEMO-0001', name: '데모 주점', jwk: storeJwk };
  store.cert = await createStoreCert({ storeId: store.id, storeName: store.name, storeJwk }, REGISTRY, { now: NOW });
  adultCred = (await issueCredential(ADULT, { issuer: ISSUER, holderJwk, now: NOW })).sdjwt;
  minorCred = (await issueCredential(MINOR, { issuer: ISSUER, holderJwk, now: NOW })).sdjwt;
});

async function presentFor(cred, registry, now = NOW) {
  const req = createRequest(registry, { storeId: store.id, storeName: store.name, now });
  return createPresentation(cred, { disclose: req.claims, nonce: req.nonce, aud: req.aud, holderJwk, now });
}

describe('발급', () => {
  test('만 나이 계산 (생일 전후)', () => {
    assert.equal(ageOn('2007-10-19', NOW), 19);
    assert.equal(ageOn('2007-10-20', NOW), 18);
    assert.equal(ageOn('1995-03-14', NOW), 31);
  });

  test('자격증명은 항목별 salt 해시 3개와 홀더 공개키를 담는다', () => {
    const { issuerJwt, disclosures } = parseSdJwt(adultCred);
    const { header, payload } = decodeJws(issuerJwt);
    assert.equal(header.typ, 'vc+sd-jwt');
    assert.equal(payload._sd.length, 3);
    assert.equal(payload.cnf.jwk.x, holderJwk.x);
    assert.equal(payload.cnf.jwk.d, undefined, '개인키가 들어가면 안 됨');
    assert.deepEqual(disclosures.map((d) => decodeDisclosure(d).name).sort(), ['age_over_19', 'birthdate', 'name']);
    assert.equal(JSON.stringify(payload).includes(ADULT.name), false, '서명 본문에 이름 평문 없음');
    assert.equal(readCredential(adultCred).claims.age_over_19, true);
    assert.equal(readCredential(minorCred).claims.age_over_19, false);
  });
});

describe('제시', () => {
  test('제시물에는 만 19세 이상 항목 하나만 들어간다', async () => {
    const vp = await presentFor(adultCred, new NonceRegistry());
    const { disclosures, kbJwt } = parseSdJwt(vp);
    assert.equal(disclosures.length, 1);
    assert.equal(decodeDisclosure(disclosures[0]).name, 'age_over_19');
    assert.ok(!vp.includes(Buffer.from(JSON.stringify(ADULT.birthdate)).toString('base64url')));
    const kb = decodeJws(kbJwt);
    assert.equal(kb.header.typ, 'kb+jwt');
    assert.equal(kb.payload.aud, store.id);
  });
});

describe('검증과 영수증', () => {
  test('성인: 결과 Y, 영수증 발급, 영수증 검증 통과', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(adultCred, reg);
    const { report, result, receipt } = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(report.ok, true, report.reason);
    assert.equal(result, 'Y');
    assert.ok(report.timings.total > 0);
    const rv = await verifyReceipt(receipt, { registryJwk: REGISTRY.jwk, now: NOW });
    assert.equal(rv.ok, true, rv.reason);
    assert.equal(rv.payload.result, 'Y');
    assert.equal(rv.payload.store, store.id);
    assert.equal(rv.payload.exp - rv.payload.iat, 90 * 86400);
  });

  test('미성년: 검증은 성공하고 결과 N', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(minorCred, reg);
    const { report, result } = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(report.ok, true);
    assert.equal(result, 'N');
  });

  test('영수증에는 개인정보가 없다 (허용 필드만, 이름·생년월일 없음)', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(adultCred, reg);
    const { receipt } = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    const { payload } = decodeJws(receipt);
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(RECEIPT_FIELDS).sort());
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(ADULT.name));
    assert.ok(!text.includes(ADULT.birthdate));
    assert.ok(!text.includes(holderJwk.x), '홀더 키(연결 가능한 식별자)도 없음');
  });

  test('같은 사람의 두 영수증은 제시물 해시가 달라 서로 연결되지 않는다', async () => {
    const reg = new NonceRegistry();
    const a = await verifyAtStore(await presentFor(adultCred, reg), { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    const b = await verifyAtStore(await presentFor(adultCred, reg), { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.notEqual(decodeJws(a.receipt).payload.vp_hash, decodeJws(b.receipt).payload.vp_hash);
  });

  test('다른 매장 앞으로 만든 제시물은 거부', async () => {
    const reg = new NonceRegistry();
    const nonce = reg.issue(NOW);
    const vp = await createPresentation(adultCred, { disclose: ['age_over_19'], nonce, aud: 'STORE-OTHER', holderJwk, now: NOW });
    const { report } = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(report.failed, 'audience');
  });
});

describe('변조 3종 + 탈취', () => {
  test('생년·연령 변조 → 선택공개 해시 불일치', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(minorCred, reg);
    const forged = tamperBirth(vp);
    assert.notEqual(forged, vp);
    const { report, receipt } = await verifyAtStore(forged, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(report.ok, false);
    assert.equal(report.failed, 'disclosure');
    assert.equal(receipt, null, '실패 시 영수증 없음');
  });

  test('서명 위조(가짜 발급기관 키) → 발급기관 서명 실패', async () => {
    const reg = new NonceRegistry();
    const nonce = reg.issue(NOW);
    const forged = await forgeWithFakeIssuer({ issuer: ISSUER, nonce, aud: store.id, now: NOW });
    const { report } = await verifyAtStore(forged, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(report.failed, 'issuer_sig');
  });

  test('재사용 nonce(캡처 QR 재제시) → nonce 실패', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(adultCred, reg);
    const first = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(first.result, 'Y');
    const second = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW + 5000 });
    assert.equal(second.report.failed, 'nonce');
    assert.match(second.report.reason, /이미 사용/);
  });

  test('다른 검증기에서 만든 nonce → unknown으로 거부', async () => {
    const vp = await presentFor(adultCred, new NonceRegistry());
    const { report } = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: new NonceRegistry(), store, now: NOW });
    assert.equal(report.failed, 'nonce');
  });

  test('nonce 유효시간(120초) 경과 → 거부', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(adultCred, reg);
    const { report } = await verifyAtStore(vp, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW + 121000 });
    assert.equal(report.failed, 'nonce');
  });

  test('탈취한 자격증명을 공격자 키로 재서명 → 홀더 바인딩 실패', async () => {
    const reg = new NonceRegistry();
    const victimVp = await presentFor(adultCred, new NonceRegistry());
    const nonce = reg.issue(NOW);
    const stolen = await stealAndRebind(victimVp, { nonce, aud: store.id, now: NOW });
    const { report } = await verifyAtStore(stolen, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    assert.equal(report.failed, 'holder_binding');
  });

  test('서명된 제시물이 아닌 입력(캡처 이미지 텍스트 등) → 형식 실패', async () => {
    const reg = new NonceRegistry();
    for (const junk of ['', '이름: 김민준 생년월일: 2000-01-01', 'abc~def', '{"age_over_19":true}']) {
      const { report } = await verifyAtStore(junk, { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
      assert.equal(report.failed, 'format', junk);
    }
  });
});

describe('영수증 위변조·만료', () => {
  async function oneReceipt() {
    const reg = new NonceRegistry();
    const { receipt } = await verifyAtStore(await presentFor(adultCred, reg), { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
    return receipt;
  }

  test('90일 이후 검증 시 보관 기한 만료', async () => {
    const r = await oneReceipt();
    assert.equal((await verifyReceipt(r, { registryJwk: REGISTRY.jwk, now: NOW + 89 * DAY_MS })).ok, true);
    const late = await verifyReceipt(r, { registryJwk: REGISTRY.jwk, now: NOW + 91 * DAY_MS });
    assert.equal(late.failed, 'retention');
  });

  test('결과 N→Y 고친 영수증 → 매장 서명 실패', async () => {
    const r = await oneReceipt();
    const [h, p, s] = r.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    payload.result = payload.result === 'Y' ? 'N' : 'Y';
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    assert.equal((await verifyReceipt(tampered, { registryJwk: REGISTRY.jwk, now: NOW })).failed, 'store_sig');
  });

  test('등록되지 않은 매장(자체 인증서) → 매장 인증서 실패', async () => {
    const rogue = await generateKeyJwk();
    const fakeRegistry = { id: REGISTRY.id, kid: REGISTRY.kid, jwk: await generateKeyJwk() };
    const cert = await createStoreCert({ storeId: 'X', storeName: '가짜', storeJwk: rogue }, fakeRegistry, { now: NOW });
    const r = await signJws({ typ: 'vreceipt+jwt', scert: cert }, { ver: 1, result: 'Y', store: 'X', iat: 1, exp: 9e9 }, rogue);
    assert.equal((await verifyReceipt(r, { registryJwk: REGISTRY.jwk, now: NOW })).failed, 'store_cert');
  });

  test('개인정보 필드를 넣은 영수증 → 개인정보 점검 실패', async () => {
    const cert = store.cert;
    const r = await signJws({ typ: 'vreceipt+jwt', scert: cert }, { ver: 1, result: 'Y', store: store.id, iat: 1, exp: 9e9, birthdate: '1995-03-14' }, store.jwk);
    const v = await verifyReceipt(r, { registryJwk: REGISTRY.jwk, now: NOW });
    assert.equal(v.failed, 'fields');
  });
});

describe('봉인 사본 (확장)', () => {
  const recipient = 'GOV-DEMO-민원실';

  test('기한 안에는 유효, 기한 후 무효, 다른 기관·철회 시 무효', async () => {
    const { token, jti } = await createSealedCopy(adultCred, {
      disclose: ['name', 'birthdate'], recipient, purpose: '전입신고 본인 확인', expiresAt: NOW + 30 * DAY_MS, holderJwk, now: NOW,
    });
    const ok = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient, now: NOW + DAY_MS });
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(ok.claims.name, ADULT.name);
    assert.equal(ok.kb.purpose, '전입신고 본인 확인');

    const late = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient, now: NOW + 31 * DAY_MS });
    assert.equal(late.ok, false);
    assert.match(late.reason, /기한/);

    const other = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient: 'BANK-X', now: NOW });
    assert.equal(other.failed, 'audience');

    const rev = await verifySealedCopy(token, { issuerJwk: ISSUER.jwk, recipient, now: NOW, revoked: [jti] });
    assert.equal(rev.failed, 'revoked');
  });

  test('기한을 늘리도록 고친 사본 → 홀더 서명 실패', async () => {
    const { token } = await createSealedCopy(adultCred, {
      disclose: ['name'], recipient, purpose: 'p', expiresAt: NOW + DAY_MS, holderJwk, now: NOW,
    });
    const parts = token.split('~');
    const [h, p, s] = parts[parts.length - 1].split('.');
    const kb = JSON.parse(Buffer.from(p, 'base64url'));
    kb.exp += 365 * 86400;
    parts[parts.length - 1] = `${h}.${Buffer.from(JSON.stringify(kb)).toString('base64url')}.${s}`;
    const v = await verifySealedCopy(parts.join('~'), { issuerJwk: ISSUER.jwk, recipient, now: NOW });
    assert.equal(v.failed, 'holder_binding');
  });
});

describe('측정', () => {
  test('CSV 내보내기와 요약 통계', async () => {
    const reg = new NonceRegistry();
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const { report } = await verifyAtStore(await presentFor(adultCred, reg), { issuerJwk: ISSUER.jwk, registry: reg, store, now: NOW });
      rows.push(toRow({ scenario: 'normal', outcome: 'Y', report, at: NOW }));
    }
    const csv = toCsv(rows);
    assert.equal(csv.split('\n').length, 6);
    assert.ok(csv.startsWith('time,scenario,outcome'));
    const s = summarize(rows.map((r) => r.total_ms));
    assert.equal(s.n, 5);
    assert.ok(s.median > 0 && s.p95 >= s.median);
  });
});
