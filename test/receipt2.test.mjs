// 영수증 v2: 업주가 혼자 만들 수 없는 영수증, 연 나이(not_youth), 1회용 묶음 발급의 비연결성.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { generateKeyJwk, decodeJws } from '../lib/jose.js';
import { ISSUER, ISSUER_KEYS, REGISTRY, LEDGER } from '../lib/demo-keys.js';
import { issueAgeBatch, issueCredential, AgeWallet, createPresentation } from '../lib/sdjwt.js';
import { notYouth, nextJan1Kst, kstMidnight, kstWeekStart } from '../lib/age.js';
import { NonceRegistry, createRequest, verifyAtStore } from '../lib/verifier.js';
import { createStoreCert } from '../lib/receipt.js';
import { verifyReceiptV2, issueReceiptV2, VerificationLedger, findReuse, linkHandles, RECEIPT_CHECKS } from '../lib/receipt2.js';
import { ownerForgeNoVp, ownerForgeFakeIssuer, ownerFlipResult, ownerBackdate, ownerResign, crossStore } from '../lib/tamper.js';

const kst = (s) => Date.parse(`${s}+09:00`);
const NOW = kst('2026-10-19T21:42:00');
const DAY_MS = 86400000;
const ADULT = { birthdate: '1998-03-14' };
const MINOR = { birthdate: '2009-05-02' };

let A, B, ledger, adultBatch, minorBatch;

async function makeStore(id) {
  const jwk = await generateKeyJwk();
  const cert = await createStoreCert({ storeId: id, storeName: id, storeJwk: jwk }, REGISTRY, { now: NOW - DAY_MS });
  return { id, name: id, jwk, cert, salt: `salt-${id}`, registry: new NonceRegistry() };
}

before(async () => {
  A = await makeStore('STORE-A');
  B = await makeStore('STORE-B');
  ledger = new VerificationLedger(LEDGER);
  adultBatch = await issueAgeBatch(ADULT, { issuer: ISSUER, count: 30, now: NOW });
  minorBatch = await issueAgeBatch(MINOR, { issuer: ISSUER, count: 5, now: NOW });
});

/** 매장 st에서 판매 posTxId 한 건: 요청 → 지갑 제시 → 검증앱 검증 + 영수증 + 원장 기록 */
async function sale(st, wallet, posTxId, now = NOW) {
  const req = await createRequest(st.registry, { storeId: st.id, storeName: st.name, posTxId, storeSalt: st.salt, now });
  const vp = await wallet.present(req, { now });
  const out = await verifyAtStore(vp, { issuerKeys: ISSUER_KEYS, registry: st.registry, store: st, ledger, now });
  assert.equal(out.report.ok, true, out.report.reason);
  return { ...out, vp, req, posTxId };
}

const audit = (receipt, { anchor, posTxId, st = A, now = NOW + 85 * DAY_MS, ...more } = {}) => verifyReceiptV2(receipt, {
  issuerKeys: ISSUER_KEYS, registryJwk: REGISTRY.jwk, ledgerJwk: LEDGER.jwk, anchor, ledger, posTxId, storeSalt: st.salt, now, ...more,
});

describe('영수증 v2: 정상', () => {
  test('T1 정상 판매 → 85일 뒤 15단계 재검증 통과 (증명은 30일 만료지만 제시 시각 기준으로 판정)', async () => {
    const s = await sale(A, new AgeWallet(adultBatch.slice(0, 2)), 'POS-1001');
    const r = await audit(s.receipt, { anchor: s.anchor, posTxId: 'POS-1001', others: [s.receipt] });
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.checks.map((c) => c.id).sort(), Object.keys(RECEIPT_CHECKS).sort(), '15단계 모두 실행');
    assert.equal(r.payload.result, 'Y');
    assert.ok(decodeJws(s.receipt).payload.vp.length > 0);
    const ent = ledger.entries.find((e) => e.rh === r.anchor.rh);
    assert.deepEqual(Object.keys(ent).sort(), ['ph', 'result', 'rh', 'sp', 't'], '원장에는 해시·매장 가명·시각·결과만');
    assert.notEqual(ent.sp, A.id, '원장에는 실제 매장 ID 대신 등록기관이 매긴 가명');
    assert.equal(ent.sp, decodeJws(A.cert).payload.pid);
  });
});

describe('영수증 v2: 업주 공격', () => {
  test('T2 업주 자가 발급: 손님 제시물 없이 매장 키로만 서명 → 거부', async () => {
    const forged = await ownerForgeNoVp(A, { posTxId: 'POS-2001', now: NOW });
    const r = await audit(forged, { anchor: await ledger.anchor(forged, NOW), posTxId: 'POS-2001' });
    assert.equal(r.failed, 'format');
    assert.match(r.reason, /vp/);
  });

  test('T3 업주 자가 발급: 가짜 발급기관·가짜 손님 키로 만든 증명을 넣음 → 발급기관 서명 실패', async () => {
    const forged = await ownerForgeFakeIssuer(A, { issuer: ISSUER, posTxId: 'POS-2002', now: NOW });
    const r = await audit(forged, { anchor: await ledger.anchor(forged, NOW), posTxId: 'POS-2002' });
    assert.equal(r.failed, 'issuer_sig');
  });

  test('T4 N→Y 재서명: 청소년에게 받은 N 영수증을 매장 키로 고쳐 서명하고 원장에 올려도 거부', async () => {
    const s = await sale(A, new AgeWallet(minorBatch.slice(0, 1)), 'POS-2003');
    assert.equal(s.result, 'N');
    const flipped = await ownerFlipResult(s.receipt, A);
    const r = await audit(flipped, { anchor: await ledger.anchor(flipped, NOW), posTxId: 'POS-2003' });
    assert.equal(r.failed, 'result');
    assert.equal((await audit(s.receipt, { anchor: s.anchor, posTxId: 'POS-2003' })).ok, true, '원래 N 영수증은 그대로 유효');
  });

  test('T5 바꿔치기: 다른 판매의 성인 영수증을 단속 대상 거래번호로 제출 → 거래 불일치', async () => {
    const s = await sale(A, new AgeWallet(adultBatch.slice(2, 3)), 'POS-2004');
    const r = await audit(s.receipt, { anchor: s.anchor, posTxId: 'POS-2999' });
    assert.equal(r.failed, 'tx_binding');
    assert.match(r.reason, /바꿔치기/);
  });

  test('T6 같은 성인 증명 돌려쓰기: 지갑은 거부하고, 강제로 만든 두 영수증은 findReuse·단일 사용 검사가 탐지', async () => {
    const w = new AgeWallet(adultBatch.slice(3, 4));
    const req1 = await createRequest(A.registry, { storeId: A.id, posTxId: 'POS-2005', storeSalt: A.salt, now: NOW });
    await w.present(req1, { now: NOW });
    await assert.rejects(w.present(req1, { now: NOW, index: 0 }), /이미 쓴/);
    // 지갑을 우회해 같은 증명으로 두 판매에 제시
    const { sdjwt, holderJwk } = adultBatch[3];
    const receipts = [];
    for (const posTxId of ['POS-2006', 'POS-2007']) {
      const req = await createRequest(A.registry, { storeId: A.id, posTxId, storeSalt: A.salt, now: NOW });
      const vp = await createPresentation(sdjwt, { disclose: ['not_youth'], nonce: req.nonce, aud: A.id, holderJwk, now: NOW, transactionData: req.transaction_data });
      receipts.push((await verifyAtStore(vp, { issuerKeys: ISSUER_KEYS, registry: A.registry, store: A, now: NOW })).receipt);
    }
    const reuse = await findReuse(receipts);
    assert.equal(reuse.length, 1);
    assert.equal(reuse[0].receipts.length, 2);
    const r = await audit(receipts[1], { posTxId: 'POS-2007', others: receipts });
    assert.equal(r.failed, 'single_use');
  });

  test('T7 다른 매장(B) 앞으로 만든 제시물을 A 영수증에 끼워 넣기 → 수신자 불일치', async () => {
    const req = await createRequest(B.registry, { storeId: B.id, posTxId: 'B-1', storeSalt: B.salt, now: NOW });
    const vpForB = await new AgeWallet(adultBatch.slice(4, 5)).present(req, { now: NOW });
    const forged = await crossStore(vpForB, A, { posTxId: 'POS-2008', now: NOW });
    const r = await audit(forged, { anchor: await ledger.anchor(forged, NOW), posTxId: 'POS-2008' });
    assert.equal(r.failed, 'audience');
  });

  test('T8 B매장 요청(nonce)으로 만든 제시물을 A 검증앱에 냄 → 검증 시점에 nonce 거부, 영수증 없음', async () => {
    const req = await createRequest(B.registry, { storeId: A.id, posTxId: 'B-2', storeSalt: B.salt, now: NOW });
    const vp = await new AgeWallet(adultBatch.slice(5, 6)).present(req, { now: NOW });
    const out = await verifyAtStore(vp, { issuerKeys: ISSUER_KEYS, registry: A.registry, store: A, now: NOW });
    assert.equal(out.report.failed, 'nonce');
    assert.equal(out.receipt, null);
  });

  test('T9 시각 조작: 영수증 시각을 3시간 앞당겨 재서명 → 손님 폰 서명 시각과 불일치', async () => {
    const s = await sale(A, new AgeWallet(adultBatch.slice(6, 7)), 'POS-2009');
    const forged = await ownerBackdate(s.receipt, A, -3 * 3600);
    const r = await audit(forged, { anchor: await ledger.anchor(forged, NOW), posTxId: 'POS-2009' });
    assert.equal(r.failed, 'time');
  });

  test('T10 사후 생성: 원장 기록이 영수증보다 25시간 뒤 → 원장 검사 실패', async () => {
    const s = await sale(A, new AgeWallet(adultBatch.slice(7, 8)), 'POS-2010');
    const late = await ledger.anchor(s.receipt, NOW + 25 * 3600000);
    assert.equal((await audit(s.receipt, { anchor: late, posTxId: 'POS-2010' })).failed, 'anchor');
    const other = await sale(A, new AgeWallet(adultBatch.slice(8, 9)), 'POS-2011');
    assert.equal((await audit(s.receipt, { anchor: other.anchor, posTxId: 'POS-2010' })).failed, 'anchor', '다른 영수증의 원장 기록은 쓸 수 없음');
  });

  test('T11 매장 키 폐기: 폐기 시각 이후 영수증은 실패, 이전 영수증은 통과', async () => {
    const before = await sale(A, new AgeWallet(adultBatch.slice(9, 10)), 'POS-2012', NOW);
    const after = await sale(A, new AgeWallet(adultBatch.slice(10, 11)), 'POS-2013', NOW + 3600000);
    const revokedStores = { [decodeJws(A.cert).payload.pid]: Math.floor((NOW + 1800000) / 1000) }; // 공개 폐기 목록(매장 가명 기준)
    assert.equal((await audit(before.receipt, { anchor: before.anchor, posTxId: 'POS-2012', revokedStores })).ok, true);
    assert.equal((await audit(after.receipt, { anchor: after.anchor, posTxId: 'POS-2013', revokedStores })).failed, 'store_cert');
  });

  test('T16 다른 요청의 nonce로 영수증 nonce를 바꿔 재서명 → nonce 불일치', async () => {
    const s = await sale(A, new AgeWallet(adultBatch.slice(11, 12)), 'POS-2014');
    const forged = await ownerResign(s.receipt, A, () => ({ nonce: 'other-request-nonce' }));
    const r = await audit(forged, { anchor: await ledger.anchor(forged, NOW), posTxId: 'POS-2014' });
    assert.equal(r.failed, 'nonce');
  });
});

describe('영수증 v2: 개인정보·비연결성', () => {
  test('T12 같은 날 발급된 두 증명도 홀더 키·salt·iat·exp 어느 것으로도 연결되지 않는다', async () => {
    const w = new AgeWallet(adultBatch.slice(12, 14)); // 같은 사람, 같은 날(같은 묶음) 발급
    const a = await sale(A, w, 'POS-3001', NOW);
    const b = await sale(B, w, 'B-3001', NOW + 2 * 3600000);
    const ha = await linkHandles(a.receipt);
    const hb = await linkHandles(b.receipt);
    assert.notEqual(ha.cnfThumb, hb.cnfThumb, '홀더 키');
    assert.notEqual(ha.issuerSig, hb.issuerSig, '발급기관 서명');
    assert.equal(ha.salts.filter((x) => hb.salts.includes(x)).length, 0, 'salt');
    // iat·exp는 그 주에 발급받은 모든 이용자에게 같은 값이다: 다른 사람·다른 요일·다른 시각에 받은 증명과 구별되지 않는다
    const others = [];
    // NOW는 2026-10-19(월) 21:42 KST. 같은 주 월요일 새벽·목요일·일요일 밤에 다른 사람들이 받은 증명
    const SUNDAY = NOW + 6 * DAY_MS + 2 * 3600000 - 60000;
    for (const [who, at] of [[{ birthdate: '1985-07-07' }, NOW - 21 * 3600000], [{ birthdate: '2001-11-30' }, NOW + 3 * DAY_MS], [ADULT, SUNDAY]]) {
      const [c] = await issueAgeBatch(who, { issuer: ISSUER, count: 1, now: at });
      others.push(decodeJws(c.sdjwt.split('~')[0]).payload);
    }
    for (const o of others) {
      assert.equal(o.iat, ha.iat, 'iat는 발급 주 공통값');
      assert.equal(o.exp, ha.exp, 'exp는 공통 경계');
    }
    assert.equal(ha.iat, hb.iat);
    assert.equal(ha.exp, hb.exp);
    assert.equal(ha.iat, kstWeekStart(NOW));
    assert.equal(new Date((ha.iat + 9 * 3600) * 1000).getUTCDay(), 1, '월요일 0시(KST)');
    assert.notEqual(others[2].iat, kstMidnight(SUNDAY), '발급일(하루 단위)은 남기지 않음');
  });

  test('T17 매장 A에서 쓴 1회용 증명을 매장 B 영수증에 다시 쓰면 원장 대조로 거부된다', async () => {
    const item = adultBatch[15];
    const copy = { sdjwt: item.sdjwt, holderJwk: item.holderJwk }; // 복제된 지갑(같은 증명·같은 키)
    const a = await sale(A, new AgeWallet([item]), 'POS-3101', NOW);
    const b = await sale(B, new AgeWallet([copy]), 'B-3101', NOW + 3600000); // 매장 B는 혼자서는 알 수 없음
    const rb = await audit(b.receipt, { anchor: b.anchor, posTxId: 'B-3101', st: B });
    assert.equal(rb.failed, 'single_use');
    assert.match(rb.reason, /다른 매장/);
    const ra = await audit(a.receipt, { anchor: a.anchor, posTxId: 'POS-3101' });
    assert.equal(ra.ok, true, '먼저 쓴 영수증은 통과');
    assert.ok(ra.warnings.some((x) => /뒤에 다른 영수증/.test(x)));
    // 원장에는 증명 해시만 있고 손님 정보·제시물 원문은 없다
    const dump = JSON.stringify(ledger.entries);
    for (const bad of [ADULT.birthdate, 'not_youth', item.sdjwt.split('~')[0], item.holderJwk.x, A.id, B.id]) assert.ok(!dump.includes(bad), bad);
  });

  test('T18 단속 기관이 기대한 목적과 손님이 서명한 목적이 다르면 거부', async () => {
    const s = await sale(A, new AgeWallet(adultBatch.slice(16, 17)), 'POS-3201');
    assert.equal((await audit(s.receipt, { anchor: s.anchor, posTxId: 'POS-3201', expectedPurpose: 'LIQUOR' })).ok, true);
    const r = await audit(s.receipt, { anchor: s.anchor, posTxId: 'POS-3201', expectedPurpose: 'TOBACCO' });
    assert.equal(r.failed, 'tx_binding');
    assert.match(r.reason, /목적/);
  });

  test('T14 영수증에 생년월일 공개 항목이 끼어 있으면 거부', async () => {
    const holderJwk = await generateKeyJwk();
    const { sdjwt } = await issueCredential({ name: '김하나', birthdate: '1998-03-14', not_youth: true }, { issuer: ISSUER, holderJwk, now: NOW });
    const req = await createRequest(A.registry, { storeId: A.id, posTxId: 'POS-4001', storeSalt: A.salt, now: NOW });
    const vp = await createPresentation(sdjwt, { disclose: ['not_youth', 'birthdate'], nonce: req.nonce, aud: A.id, holderJwk, now: NOW, transactionData: req.transaction_data });
    const rc = await issueReceiptV2({ vp, nonce: req.nonce, td: req.transaction_data[0], result: 'Y' }, { storeJwk: A.jwk, storeCert: A.cert, storeId: A.id, now: NOW });
    const r = await audit(rc, { anchor: await ledger.anchor(rc, NOW), posTxId: 'POS-4001' });
    assert.equal(r.failed, 'disclosure');
    assert.match(r.reason, /birthdate/);
  });
});

describe('연 나이 (청소년 보호법 제2조 제1호)', () => {
  test('T13 경계: 12월 31일생·1월 1일생, 올해 19세가 되는 해', () => {
    assert.equal(notYouth('2007-12-31', kst('2026-01-01T00:00:00')), true, '2007년생은 2026-01-01 0시부터 청소년 아님');
    assert.equal(notYouth('2007-12-31', kst('2025-12-31T23:59:59')), false);
    assert.equal(notYouth('2008-01-01', kst('2026-12-31T23:59:59')), false, '2008-01-01생은 2026년 내내 청소년');
    assert.equal(notYouth('2008-01-01', kst('2027-01-01T00:00:00')), true);
    // 만 나이로는 18세(생일 전)이지만 19세가 되는 해이므로 청소년 아님
    assert.equal(notYouth('2007-10-20', NOW), true);
    // 한국 시각 기준: UTC로는 아직 12월 31일이어도 한국이 1월 1일이면 새해
    assert.equal(notYouth('2007-06-01', Date.parse('2025-12-31T15:00:00Z')), true);
  });

  test('T15 false 증명은 다음 해 1월 1일 0시(KST)에 만료된다', async () => {
    const at = kst('2026-12-20T10:00:00');
    const [cred] = await issueAgeBatch({ birthdate: '2008-01-01' }, { issuer: ISSUER, count: 1, now: at });
    const p = decodeJws(cred.sdjwt.split('~')[0]).payload;
    assert.ok(p.exp <= nextJan1Kst(at));
    assert.equal(p.exp, kst('2027-01-01T00:00:00') / 1000);
    const [adultCred] = await issueAgeBatch({ birthdate: '1998-03-14' }, { issuer: ISSUER, count: 1, now: at });
    assert.equal(decodeJws(adultCred.sdjwt.split('~')[0]).payload.exp - kstWeekStart(at), 35 * 86400, 'true 증명은 발급 주 시작부터 5주');

    const st = await makeStore('STORE-C');
    const present = async (now) => {
      const req = await createRequest(st.registry, { storeId: st.id, posTxId: `C-${now}`, storeSalt: st.salt, now });
      const vp = await new AgeWallet([cred]).present(req, { now });
      return verifyAtStore(vp, { issuerKeys: ISSUER_KEYS, registry: st.registry, store: st, now });
    };
    const dec31 = await present(kst('2026-12-31T23:50:00'));
    assert.equal(dec31.result, 'N');
    const jan1 = await present(kst('2027-01-01T00:00:01'));
    assert.equal(jan1.report.failed, 'validity', '새해에는 묵은 false 증명을 쓸 수 없음(새 묶음 필요)');
    // 12월 31일의 N 영수증은 해가 바뀐 뒤에도 그 시각 기준으로 재검증된다
    const r = await verifyReceiptV2(dec31.receipt, { issuerKeys: ISSUER_KEYS, registryJwk: REGISTRY.jwk, now: kst('2027-02-01T00:00:00') });
    assert.equal(r.ok, true, r.reason);
  });
});
