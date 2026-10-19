// 검증 결과 영수증 v2: 업주가 혼자 만들 수 없는 영수증.
// - 손님 지갑이 1회용 연령 증명(발급기관 서명 SD-JWT)으로 만든 제시물 원문(vp)을 담는다.
//   제시물의 홀더 서명(KB-JWT)에는 매장 ID(aud)·매장 nonce·시각(iat)·판매 거래 해시(transaction_data_hashes)가 묶인다.
// - 검증앱이 매장 키로 영수증 전체를 서명한다(헤더 scert = 등록기관이 서명한 매장 인증서).
// - 가상 공통기반 「검증 사실 원장」이 영수증 해시에 시각 확인(anchor)을 서명한다. 원장에는 손님 정보가 없고 매장은 가명이며,
//   증명 해시(발급기관 서명값의 해시)로 매장을 넘는 1회용 증명 재사용을 찾는다.
// 구청은 서버 조회 없이 발급기관·손님·매장·원장 서명과 거래번호를 모두 다시 검사한다(verifyReceiptV2, 15단계).
import { signJws, verifyJws, decodeJws, sha256, randomId, jsonFromB64u, jwkThumbprint } from './jose.js';
import { verifyPresentation, parseSdJwt, decodeDisclosure } from './sdjwt.js';
import { RETENTION_DAYS, PII_PATTERNS } from './receipt.js';

const DAY = 86400;
const nowSec = (ms) => Math.floor(ms / 1000);
export const RECEIPT_TYP = 'vreceipt+jwt;v=2';
export const ANCHOR_TYP = 'vanchor+jwt';
export const TD_TYPE = 'kr.mid.age_check.sale';
export const MAX_SKEW_SEC = 300; // 영수증 시각과 손님 폰 서명 시각의 허용 차이
export const MAX_ANCHOR_DELAY_SEC = DAY; // 원장 기록은 영수증 발급 뒤 24시간 안

/** 판매 거래번호 해시. 매장 비밀 salt를 섞어 매장 밖에서는 거래번호를 알아낼 수 없다 */
export function posTxHash(posTxId, storeSalt = '') {
  return sha256(`${posTxId}|${storeSalt}`);
}

// 영수증 payload에 허용되는 필드. 이 밖의 필드가 있으면 형식 오류로 본다.
export const RECEIPT_FIELDS = {
  ver: '형식 버전 (2)',
  rid: '영수증 번호(무작위)',
  result: '결과 (Y/N)',
  claim: '확인 항목',
  purpose: '목적 코드',
  store: '매장 ID',
  iat: '검증 시각',
  exp: '파기 예정 (90일)',
  nonce: '매장 요청 nonce',
  td: '판매 거래 데이터 (base64url)',
  vp: '손님 1회용 제시물 원문',
};
const REQUIRED = Object.keys(RECEIPT_FIELDS);

export const RECEIPT_CHECKS = {
  format: '형식·허용 필드',
  store_cert: '매장 인증서 (등록기관 서명·폐기)',
  store_sig: '매장 서명',
  issuer_sig: '발급기관 서명 (제시물)',
  validity_at: '증명 유효기간 (제시 시각 기준)',
  disclosure: '공개 항목은 청소년 아님 하나뿐',
  holder_binding: '손님 서명 (1회용 키)',
  audience: '이 매장 앞 제시물',
  nonce: '이 매장 요청 nonce',
  tx_binding: '이 판매 거래',
  time: '이 시각 (손님 폰 서명 시각)',
  anchor: '공통기반 원장 기록',
  result: '결과 = 발급기관 판정',
  single_use: '같은 증명 재사용 없음',
  retention: '보관 기한 (90일)',
};

/** 영수증 v2 발급(검증앱). td는 요청에 넣었던 base64url 문자열 그대로 */
export async function issueReceiptV2({ vp, nonce, td, result }, { storeJwk, storeCert, storeId, now = Date.now(), retentionDays = RETENTION_DAYS, claim = 'not_youth' }) {
  if (result !== 'Y' && result !== 'N') throw new Error('result는 Y 또는 N');
  const iat = nowSec(now);
  const payload = {
    ver: 2,
    rid: randomId(9),
    result,
    claim,
    purpose: jsonFromB64u(td).purpose,
    store: storeId,
    iat,
    exp: iat + retentionDays * DAY,
    nonce,
    td,
    vp: vp.trim(),
  };
  return signJws({ typ: RECEIPT_TYP, scert: storeCert }, payload, storeJwk);
}

export const receiptHash = (jws) => sha256(String(jws).trim());

/** 1회용 증명 해시: 제시물 안 발급기관 JWT의 서명 부분 해시. 손님 정보가 아니라 발급기관 서명값에서 나온다 */
export function proofHash(vp) {
  return sha256(parseSdJwt(vp).issuerJwt.split('.')[2] || '');
}

/**
 * 가상 공통기반 「검증 사실 원장」. 검증앱은 영수증 해시·증명 해시·매장 가명·결과만 보낸다고 본다.
 * 원장에는 (rh, ph, sp, t, result)만 남고 손님 정보·제시물 원문·실제 매장 ID는 없다.
 * ph(증명 해시)로 매장을 넘는 1회용 증명 재사용을 찾는다(R14).
 */
export class VerificationLedger {
  constructor(key) {
    this.key = key; // { id, kid, jwk }
    this.entries = [];
    this.revoked = {}; // 공개 폐기 목록: 매장 가명 → 폐기 시각(epoch s)
  }
  async anchor(receiptJws, now = Date.now()) {
    const d = decodeJws(String(receiptJws).trim());
    const sp = decodeJws(d.header.scert).payload.pid;
    if (!sp) throw new Error('매장 인증서에 가명 ID(pid)가 없습니다');
    let ph = null; // 제시물이 없는 영수증(업주 자가 발급)은 증명 해시 없이 기록되고, 재검증 R1에서 걸린다
    try { ph = await proofHash(d.payload.vp); } catch { /* 형식 오류는 재검증이 판정 */ }
    const entry = { rh: await receiptHash(receiptJws), ph, sp, t: nowSec(now), result: d.payload.result };
    this.entries.push(entry);
    return signJws({ typ: ANCHOR_TYP, kid: this.key.kid }, { iss: this.key.id, rh: entry.rh, sp, t: entry.t }, this.key.jwk);
  }
  has(rh) { return this.entries.some((e) => e.rh === rh); }
  /** 같은 증명 해시로 기록된 항목들(기록 순서) */
  proofUses(ph) { return this.entries.filter((e) => e.ph === ph); }
  count(sp, fromMs = 0, toMs = Infinity) {
    return this.entries.filter((e) => e.sp === sp && e.t * 1000 >= fromMs && e.t * 1000 <= toMs).length;
  }
  revokeStore(pid, atMs = Date.now()) { this.revoked[pid] = nowSec(atMs); }
}

/** 같은 1회용 증명(발급기관 서명)이 두 번 이상 쓰인 영수증 묶음 */
export async function findReuse(receipts) {
  const by = new Map();
  for (const r of receipts) {
    let key;
    try { key = await proofHash(decodeJws(String(r).trim()).payload.vp); } catch { continue; }
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()].filter(([, list]) => list.length > 1).map(([issuerHash, list]) => ({ issuerHash, receipts: list }));
}

/** 연결성 시험용: 영수증에서 손님을 가리킬 수 있는 값들 */
export async function linkHandles(receiptJws) {
  const { vp } = decodeJws(String(receiptJws).trim()).payload;
  const { issuerJwt, disclosures } = parseSdJwt(vp);
  const iss = decodeJws(issuerJwt);
  return {
    cnfThumb: await jwkThumbprint(iss.payload.cnf.jwk),
    issuerSig: issuerJwt.split('.')[2],
    salts: disclosures.map((d) => decodeDisclosure(d).salt),
    iat: iss.payload.iat,
    exp: iss.payload.exp,
  };
}

// 제시물 검사 id → 영수증 검사 id
const VP_TO_R = { format: 'issuer_sig', issuer_sig: 'issuer_sig', validity: 'validity_at', disclosure: 'disclosure', holder_binding: 'holder_binding', audience: 'audience', tx_binding: 'tx_binding', claim: 'disclosure' };

/**
 * 영수증 v2 재검증(구청). 서버 조회 없이 공개키만으로 검사한다. 앞 단계에서 실패하면 멈춘다.
 * opts: issuerKeys {kid: jwk}, registryJwk, ledgerJwk, anchor(원장 확인 JWS), ledger(있으면 기록 존재도 확인),
 *       revokedStores(공개 폐기 목록을 내려받은 것) {매장 가명: 폐기 시각 s}, posTxId·storeSalt(단속 대상 판매),
 *       expectedPurpose(단속 기관이 기대하는 목적 코드), others(같은 매장의 다른 영수증들), now
 */
export async function verifyReceiptV2(jws, opts) {
  const { issuerKeys, registryJwk, ledgerJwk, anchor = null, ledger = null, revokedStores = {}, posTxId, storeSalt = '', expectedPurpose, others = null, now = Date.now() } = opts;
  const checks = [];
  const warnings = [];
  const report = { ok: false, checks, warnings, payload: null, store: null, kb: null, td: null, anchor: null };
  const pass = (id, detail = '', extra = {}) => checks.push({ id, label: RECEIPT_CHECKS[id], ok: true, detail, ...extra });
  const fail = (id, detail) => { checks.push({ id, label: RECEIPT_CHECKS[id], ok: false, detail }); report.failed = id; report.reason = detail; return report; };
  const str = String(jws ?? '').trim();

  // R1 형식
  let d;
  try {
    d = decodeJws(str);
    if (d.header.typ !== RECEIPT_TYP) throw new Error(`영수증 유형(${RECEIPT_TYP})이 아닙니다`);
    if (!d.header.scert) throw new Error('매장 인증서가 없습니다');
  } catch (e) {
    return fail('format', e.message);
  }
  const P = d.payload;
  report.payload = P;
  const extra = Object.keys(P).filter((k) => !(k in RECEIPT_FIELDS));
  if (extra.length) return fail('format', `허용되지 않은 필드: ${extra.join(', ')}`);
  const missing = REQUIRED.filter((k) => P[k] === undefined || P[k] === '');
  if (missing.length) return fail('format', `필수 필드 없음: ${missing.join(', ')}${missing.includes('vp') ? ' (손님 제시물 없이 매장이 만든 영수증)' : ''}`);
  for (const k of ['result', 'claim', 'purpose', 'store', 'rid', 'nonce']) {
    for (const [re, label] of PII_PATTERNS) if (re.test(String(P[k]))) return fail('format', `${k} 값이 ${label}입니다`);
  }
  pass('format', `필드 ${Object.keys(P).length}개, 모두 허용 목록`);

  // R2 매장 인증서
  let cert;
  try { cert = decodeJws(d.header.scert).payload; } catch { return fail('store_cert', '매장 인증서 형식 오류'); }
  if (!(await verifyJws(d.header.scert, registryJwk))) return fail('store_cert', '등록기관이 서명한 매장 인증서가 아닙니다');
  if (cert.sub !== P.store) return fail('store_cert', '영수증의 매장 ID와 인증서가 다릅니다');
  if (P.iat < cert.iat || P.iat > cert.exp) return fail('store_cert', '영수증 시각에 매장 인증서가 유효하지 않았습니다');
  if (typeof revokedStores[cert.pid] === 'number' && P.iat >= revokedStores[cert.pid]) return fail('store_cert', '매장 키가 폐기된 뒤에 만든 영수증입니다');
  report.store = { id: cert.sub, name: cert.name };
  pass('store_cert', `${cert.name} (${cert.sub})`);

  // R3 매장 서명
  if (!(await verifyJws(str, cert.jwk))) return fail('store_sig', '매장 서명이 맞지 않습니다 (영수증 변조)');
  pass('store_sig', '일치');

  // R4~R8, R10(손님 서명 안의 해시): 담긴 제시물을 발급기관·손님 서명까지 다시 검사
  const vr = await verifyPresentation(P.vp, {
    issuerKeys, expectedAud: P.store, requiredClaims: ['not_youth'], expectedTd: P.td, validityAtKbIat: true, now,
  });
  const seenR = new Set();
  for (const c of vr.checks) {
    const r = VP_TO_R[c.id];
    if (!r || (c.ok && (c.id === 'format' || c.id === 'tx_binding'))) continue; // 거래 결합 통과는 아래 R10에서 한 번에 표시
    if (!c.ok) {
      const head = r === 'issuer_sig' && c.id === 'format' ? '담긴 제시물이 서명된 증명이 아닙니다: ' : '';
      return fail(r, head + c.detail + (r === 'issuer_sig' ? ' (업주·위조 앱이 만든 증명)' : ''));
    }
    if (!seenR.has(r)) { seenR.add(r); pass(r, c.detail); }
  }
  if (!vr.ok) return fail('issuer_sig', vr.reason || '제시물 검증 실패');
  report.kb = vr.kb;
  const discl = parseSdJwt(P.vp).disclosures.map((x) => decodeDisclosure(x).name);
  if (vr.discarded.length || discl.length !== 1) return fail('disclosure', `청소년 아님 외의 항목이 들어 있습니다: ${discl.filter((n) => n !== 'not_youth').join(', ') || '-'}`);

  // R9 nonce
  if (vr.kb.nonce !== P.nonce) return fail('nonce', '손님이 서명한 nonce가 영수증의 요청과 다릅니다');
  pass('nonce', '일치');

  // R10 거래 데이터 내용
  let td;
  try { td = jsonFromB64u(P.td); } catch { return fail('tx_binding', '거래 데이터 형식 오류'); }
  report.td = td;
  if (td.type !== TD_TYPE) return fail('tx_binding', '연령 확인 판매 거래 데이터가 아닙니다');
  if (td.store !== P.store) return fail('tx_binding', '거래 데이터의 매장이 영수증 매장과 다릅니다');
  if (td.purpose !== P.purpose) return fail('tx_binding', '거래 데이터의 목적이 영수증 목적과 다릅니다');
  if (expectedPurpose !== undefined && td.purpose !== expectedPurpose) return fail('tx_binding', `손님이 서명한 목적(${td.purpose})이 단속 대상 목적(${expectedPurpose})과 다릅니다`);
  if (posTxId !== undefined) {
    if (td.pos_tx_hash !== (await posTxHash(posTxId, storeSalt))) return fail('tx_binding', `단속 대상 판매(${posTxId})의 영수증이 아닙니다 (바꿔치기)`);
    pass('tx_binding', `거래번호 ${posTxId} 일치`);
  } else {
    pass('tx_binding', '손님 서명에 묶인 거래 데이터 일치 (거래번호 대조 안 함)');
  }

  // R11 시각
  const skew = Math.abs(P.iat - vr.kb.iat);
  if (skew > MAX_SKEW_SEC) return fail('time', `영수증 시각이 손님 폰 서명 시각과 ${Math.round(skew / 60)}분 다릅니다 (시각 조작)`);
  pass('time', `손님 서명과 ${skew}초 차이`);

  // R12 공통기반 원장
  if (anchor) {
    let a;
    try { a = decodeJws(String(anchor).trim()); } catch { return fail('anchor', '원장 확인 형식 오류'); }
    if (a.header.typ !== ANCHOR_TYP || !ledgerJwk || !(await verifyJws(String(anchor).trim(), ledgerJwk))) return fail('anchor', '공통기반이 서명한 원장 확인이 아닙니다');
    const rh = await receiptHash(str);
    if (a.payload.rh !== rh) return fail('anchor', '원장에 기록된 영수증 해시와 다릅니다');
    if (a.payload.sp !== cert.pid) return fail('anchor', '원장 기록의 매장(가명)이 다릅니다');
    const delay = a.payload.t - P.iat;
    if (delay < 0 || delay > MAX_ANCHOR_DELAY_SEC) return fail('anchor', `원장 기록 시각이 영수증보다 ${Math.round(delay / 3600)}시간 ${delay < 0 ? '앞서요' : '늦습니다'} (사후 생성 의심)`);
    if (ledger && !ledger.has(rh)) return fail('anchor', '원장에 이 영수증 기록이 없습니다');
    report.anchor = a.payload;
    pass('anchor', `기록됨 (영수증 뒤 ${delay}초)`);
  } else {
    warnings.push('공통기반 원장 확인이 없어 시각을 따로 확인하지 못했습니다');
    pass('anchor', '원장 확인 없음 (미확인 경고)', { warn: true });
  }

  // R13 결과
  const expected = vr.claims.not_youth === true ? 'Y' : 'N';
  if (P.result !== expected) return fail('result', `영수증 결과 ${P.result}가 발급기관 판정(청소년 아님 = ${vr.claims.not_youth ? '예' : '아니오'})과 다릅니다`);
  pass('result', `${P.result} = 발급기관 판정`);

  // R14 1회용: 공통기반 원장의 증명 해시 대조(매장 간) + 같은 매장 영수증 묶음(있으면)
  if (ledger || Array.isArray(others)) {
    const ph = await proofHash(P.vp);
    const rh = await receiptHash(str);
    const notes = [];
    if (ledger) {
      const uses = ledger.proofUses(ph);
      const mine = uses.findIndex((e) => e.rh === rh);
      const before = mine < 0 ? uses : uses.slice(0, mine);
      if (before.length) return fail('single_use', `공통기반 원장에 같은 1회용 증명이 먼저 기록되어 있습니다 (${before[0].sp === cert.pid ? '이 매장' : '다른 매장'} 영수증에 이미 쓰임, 재사용)`);
      if (mine >= 0 && uses.length > mine + 1) warnings.push('같은 1회용 증명이 이 영수증 뒤에 다른 영수증에도 기록됐습니다 (뒤의 것이 재사용)');
      notes.push(`원장 대조: 같은 증명 기록 ${uses.length}건 중 처음`);
    }
    if (Array.isArray(others)) {
      let n = 0;
      for (const o of others) {
        if ((await receiptHash(o)) === rh) continue;
        n++;
        let k;
        try { k = await proofHash(decodeJws(String(o).trim()).payload.vp); } catch { continue; }
        if (k === ph) return fail('single_use', '같은 1회용 증명이 이 매장의 다른 영수증에도 쓰였습니다 (돌려쓰기)');
      }
      notes.push(`이 매장 다른 영수증 ${n}건과 겹치지 않음`);
    }
    pass('single_use', notes.join(' · '));
  }

  // R15 보관 기한
  if (P.exp < nowSec(now)) return fail('retention', `보관 기한(${new Date(P.exp * 1000).toLocaleDateString('ko-KR')})이 지나 파기 대상입니다`);
  pass('retention', `${new Date(P.exp * 1000).toLocaleDateString('ko-KR')}까지`);

  report.ok = true;
  return report;
}
