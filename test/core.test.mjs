import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyJwk, decodeJws, signJws } from '../lib/jose.js';
import { ISSUER, ISSUER_KEYS, REGISTRY } from '../lib/demo-keys.js';
import { issueCredential, issueAgeBatch, AgeWallet, createPresentation, parseSdJwt, decodeDisclosure, readCredential } from '../lib/sdjwt.js';
import { notYouth } from '../lib/age.js';
import { NonceRegistry, createRequest, verifyAtStore } from '../lib/verifier.js';
import { createStoreCert } from '../lib/receipt.js';
import { verifyReceiptV2, RECEIPT_FIELDS, RECEIPT_TYP } from '../lib/receipt2.js';
import { tamperBirth, forgeWithFakeIssuer, stealAndRebind } from '../lib/tamper.js';
import { createSealedCopy, verifySealedCopy } from '../lib/sealed.js';
import { toCsv, toRow, summarize } from '../lib/measure.js';

const NOW = Date.parse('2026-10-19T12:00:00+09:00');
const DAY_MS = 86400000;
const ADULT = { name: '김민준', birthdate: '1995-03-14' };
const MINOR = { name: '이서연', birthdate: '2009-08-02' };

let idKey, store, idCred, adultBatch, minorBatch;
const opts = (reg, now = NOW) => ({ issuerKeys: ISSUER_KEYS, registry: reg, store, now });
const auditOpts = (now = NOW) => ({ issuerKeys: ISSUER_KEYS, registryJwk: REGISTRY.jwk, now });

before(async () => {
  idKey = await generateKeyJwk();
  const storeJwk = await generateKeyJwk();
  store = { id: 'STORE-DEMO-0001', name: '데모 주점', jwk: storeJwk, salt: 's' };
  store.cert = await createStoreCert({ storeId: store.id, storeName: store.name, storeJwk }, REGISTRY, { now: NOW });
  idCred = (await issueCredential(ADULT, { issuer: ISSUER, holderJwk: idKey, now: NOW })).sdjwt;
  adultBatch = await issueAgeBatch(ADULT, { issuer: ISSUER, count: 40, now: NOW });
  minorBatch = await issueAgeBatch(MINOR, { issuer: ISSUER, count: 10, now: NOW });
});

const adultWallet = () => new AgeWallet(adultBatch);
const minorWallet = () => new AgeWallet(minorBatch);
const request = (reg, now = NOW) => createRequest(reg, { storeId: store.id, storeName: store.name, posTxId: `POS-${Math.random()}`, storeSalt: store.salt, now });
async function presentFor(wallet, reg, now = NOW) {
  return wallet.present(await request(reg, now), { now });
}

describe('발급', () => {
  test('연 나이 판정: 생일과 무관하게 올해 − 출생연도 ≥ 19', () => {
    assert.equal(notYouth('2007-10-20', NOW), true, '만 18세라도 19세가 되는 해이면 청소년 아님');
    assert.equal(notYouth('2007-12-31', NOW), true);
    assert.equal(notYouth('2008-01-01', NOW), false);
    assert.equal(notYouth('1995-03-14', NOW), true);
  });

  test('신분증 자격증명은 이름·생년월일, 연령 증명은 청소년 아님 하나만 담는다', () => {
    const id = decodeJws(parseSdJwt(idCred).issuerJwt);
    assert.equal(id.header.typ, 'vc+sd-jwt');
    assert.equal(id.payload._sd.length, 2);
    assert.equal(id.payload.cnf.jwk.x, idKey.x);
    assert.equal(id.payload.cnf.jwk.d, undefined, '개인키가 들어가면 안 됨');
    assert.deepEqual(Object.keys(readCredential(idCred).claims).sort(), ['birthdate', 'name']);
    assert.equal(JSON.stringify(id.payload).includes(ADULT.name), false, '서명 본문에 이름 평문 없음');

    const age = parseSdJwt(adultBatch[0].sdjwt);
    const ap = decodeJws(age.issuerJwt).payload;
    assert.equal(ap.vct, 'urn:kr:mid:age');
    assert.equal(ap._sd.length, 1);
    assert.deepEqual(age.disclosures.map((d) => decodeDisclosure(d).name), ['not_youth']);
    assert.equal(readCredential(adultBatch[0].sdjwt).claims.not_youth, true);
    assert.equal(readCredential(minorBatch[0].sdjwt).claims.not_youth, false);
    assert.ok(!adultBatch[0].sdjwt.includes(Buffer.from(JSON.stringify(ADULT.birthdate)).toString('base64url')));
  });
});

describe('제시', () => {
  test('제시물에는 청소년 아님 항목 하나만, 홀더 서명에는 매장·nonce·거래 해시가 들어간다', async () => {
    const reg = new NonceRegistry();
    const req = await request(reg);
    const vp = await adultWallet().present(req, { now: NOW });
    const { disclosures, kbJwt } = parseSdJwt(vp);
    assert.equal(disclosures.length, 1);
    assert.equal(decodeDisclosure(disclosures[0]).name, 'not_youth');
    const kb = decodeJws(kbJwt);
    assert.equal(kb.header.typ, 'kb+jwt');
    assert.equal(kb.payload.aud, store.id);
    assert.equal(kb.payload.nonce, req.nonce);
    assert.equal(kb.payload.transaction_data_hashes.length, 1);
  });
});

describe('검증과 영수증', () => {
  test('청소년 아님: 결과 Y, 영수증 v2 발급, 영수증 재검증 통과', async () => {
    const reg = new NonceRegistry();
    const { report, result, receipt } = await verifyAtStore(await presentFor(adultWallet(), reg), opts(reg));
    assert.equal(report.ok, true, report.reason);
    assert.equal(result, 'Y');
    assert.ok(report.timings.total > 0);
    const rv = await verifyReceiptV2(receipt, auditOpts());
    assert.equal(rv.ok, true, rv.reason);
    assert.equal(rv.payload.result, 'Y');
    assert.equal(rv.payload.store, store.id);
    assert.equal(rv.payload.exp - rv.payload.iat, 90 * 86400);
  });

  test('청소년: 검증은 성공하고 결과 N', async () => {
    const reg = new NonceRegistry();
    const { report, result } = await verifyAtStore(await presentFor(minorWallet(), reg), opts(reg));
    assert.equal(report.ok, true);
    assert.equal(result, 'N');
  });

  test('영수증에는 개인정보가 없다 (허용 필드만, 이름·생년월일·신분증 키 없음)', async () => {
    const reg = new NonceRegistry();
    const { receipt } = await verifyAtStore(await presentFor(adultWallet(), reg), opts(reg));
    const { payload } = decodeJws(receipt);
    assert.deepEqual(Object.keys(payload).sort(), Object.keys(RECEIPT_FIELDS).sort());
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(ADULT.name));
    assert.ok(!text.includes(ADULT.birthdate));
    const names = parseSdJwt(payload.vp).disclosures.map((d) => decodeDisclosure(d).name);
    assert.deepEqual(names, ['not_youth'], '담긴 제시물의 공개 항목도 청소년 아님 하나');
    assert.ok(!text.includes(idKey.x), '신분증 홀더 키(연결 가능한 식별자)도 없음');
  });

  test('같은 사람의 두 영수증은 1회용 증명이 달라 서로 연결되지 않는다', async () => {
    const reg = new NonceRegistry();
    const w = adultWallet();
    const a = await verifyAtStore(await presentFor(w, reg), opts(reg));
    const b = await verifyAtStore(await presentFor(w, reg), opts(reg));
    const issuerOf = (r) => parseSdJwt(decodeJws(r).payload.vp).issuerJwt;
    assert.notEqual(issuerOf(a.receipt), issuerOf(b.receipt));
  });

  test('다른 매장 앞으로 만든 제시물은 거부', async () => {
    const reg = new NonceRegistry();
    const req = await request(reg);
    const vp = await createPresentation(adultBatch[0].sdjwt, { disclose: ['not_youth'], nonce: req.nonce, aud: 'STORE-OTHER', holderJwk: adultBatch[0].holderJwk, now: NOW, transactionData: req.transaction_data });
    const { report } = await verifyAtStore(vp, opts(reg));
    assert.equal(report.failed, 'audience');
  });
});

describe('변조 3종 + 탈취', () => {
  test('생년·연령 변조 → 선택공개 해시 불일치', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(minorWallet(), reg);
    const forged = tamperBirth(vp);
    assert.notEqual(forged, vp);
    const { report, receipt } = await verifyAtStore(forged, opts(reg));
    assert.equal(report.ok, false);
    assert.equal(report.failed, 'disclosure');
    assert.equal(receipt, null, '실패 시 영수증 없음');
  });

  test('서명 위조(가짜 발급기관 키) → 발급기관 서명 실패', async () => {
    const reg = new NonceRegistry();
    const forged = await forgeWithFakeIssuer({ issuer: ISSUER, request: await request(reg), now: NOW });
    const { report } = await verifyAtStore(forged, opts(reg));
    assert.equal(report.failed, 'issuer_sig');
  });

  test('재사용 nonce(캡처 QR 재제시) → nonce 실패', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(adultWallet(), reg);
    const first = await verifyAtStore(vp, opts(reg));
    assert.equal(first.result, 'Y');
    const second = await verifyAtStore(vp, opts(reg, NOW + 5000));
    assert.equal(second.report.failed, 'nonce');
    assert.match(second.report.reason, /이미 사용/);
  });

  test('다른 검증기에서 만든 nonce → unknown으로 거부', async () => {
    const vp = await presentFor(adultWallet(), new NonceRegistry());
    const { report } = await verifyAtStore(vp, opts(new NonceRegistry()));
    assert.equal(report.failed, 'nonce');
  });

  test('nonce 유효시간(120초) 경과 → 거부', async () => {
    const reg = new NonceRegistry();
    const vp = await presentFor(adultWallet(), reg);
    const { report } = await verifyAtStore(vp, opts(reg, NOW + 121000));
    assert.equal(report.failed, 'nonce');
  });

  test('탈취한 증명을 공격자 키로 재서명 → 홀더 바인딩 실패', async () => {
    const reg = new NonceRegistry();
    const victimVp = await presentFor(adultWallet(), new NonceRegistry());
    const req = await request(reg);
    const stolen = await stealAndRebind(victimVp, { nonce: req.nonce, aud: store.id, now: NOW, transactionData: req.transaction_data });
    const { report } = await verifyAtStore(stolen, opts(reg));
    assert.equal(report.failed, 'holder_binding');
  });

  test('서명된 제시물이 아닌 입력(캡처 이미지 텍스트 등) → 형식 실패', async () => {
    const reg = new NonceRegistry();
    for (const junk of ['', '이름: 김민준 생년월일: 2000-01-01', 'abc~def', '{"not_youth":true}']) {
      const { report } = await verifyAtStore(junk, opts(reg));
      assert.equal(report.failed, 'format', junk);
    }
  });
});

describe('영수증 위변조·만료', () => {
  async function oneReceipt() {
    const reg = new NonceRegistry();
    return (await verifyAtStore(await presentFor(adultWallet(), reg), opts(reg))).receipt;
  }

  test('90일 이후 검증 시 보관 기한 만료', async () => {
    const r = await oneReceipt();
    assert.equal((await verifyReceiptV2(r, auditOpts(NOW + 89 * DAY_MS))).ok, true);
    const late = await verifyReceiptV2(r, auditOpts(NOW + 91 * DAY_MS));
    assert.equal(late.failed, 'retention');
  });

  test('재서명 없이 결과를 고친 영수증 → 매장 서명 실패', async () => {
    const r = await oneReceipt();
    const [h, p, s] = r.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url'));
    payload.result = payload.result === 'Y' ? 'N' : 'Y';
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    assert.equal((await verifyReceiptV2(tampered, auditOpts())).failed, 'store_sig');
  });

  test('등록되지 않은 매장(자체 인증서) → 매장 인증서 실패', async () => {
    const r = await oneReceipt();
    const rogue = await generateKeyJwk();
    const fakeRegistry = { id: REGISTRY.id, kid: REGISTRY.kid, jwk: await generateKeyJwk() };
    const cert = await createStoreCert({ storeId: store.id, storeName: '가짜', storeJwk: rogue }, fakeRegistry, { now: NOW });
    const forged = await signJws({ typ: RECEIPT_TYP, scert: cert }, decodeJws(r).payload, rogue);
    assert.equal((await verifyReceiptV2(forged, auditOpts())).failed, 'store_cert');
  });

  test('개인정보 필드를 넣은 영수증 → 형식(허용 필드) 실패', async () => {
    const r = await oneReceipt();
    const forged = await signJws({ typ: RECEIPT_TYP, scert: store.cert }, { ...decodeJws(r).payload, birthdate: '1995-03-14' }, store.jwk);
    const v = await verifyReceiptV2(forged, auditOpts());
    assert.equal(v.failed, 'format');
    assert.match(v.reason, /birthdate/);
  });
});

describe('봉인 사본 (확장)', () => {
  const recipient = 'GOV-DEMO-민원실';

  test('기한 안에는 유효, 기한 후 무효, 다른 기관·철회 시 무효', async () => {
    const { token, jti } = await createSealedCopy(idCred, {
      disclose: ['name', 'birthdate'], recipient, purpose: '전입신고 본인 확인', expiresAt: NOW + 30 * DAY_MS, holderJwk: idKey, now: NOW,
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
    const { token } = await createSealedCopy(idCred, {
      disclose: ['name'], recipient, purpose: 'p', expiresAt: NOW + DAY_MS, holderJwk: idKey, now: NOW,
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
    const w = adultWallet();
    const rows = [];
    for (let i = 0; i < 5; i++) {
      const { report } = await verifyAtStore(await presentFor(w, reg), opts(reg));
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
