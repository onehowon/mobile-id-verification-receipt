// SD-JWT 형식을 직접 구현한 데모 코드(표준 라이브러리 미사용): 항목별 salt 해시(_sd) + 발급기관 서명 + 홀더 키 바인딩(KB-JWT).
// 형식: <발급기관 JWT>~<공개 항목 1>~...~<KB-JWT>
// RFC 9901(SD-JWT)의 구조를 따르되 데모를 위해 단순화했다(배열 요소 공개, 디코이 해시, 상태 목록 등은 생략).
// KB-JWT의 transaction_data_hashes는 OpenID4VP 1.0 부록 B.3.3.1의 방식(요청의 transaction_data 문자열별 SHA-256)이다.
import { b64uJson, jsonFromB64u, sha256, randomId, signJws, verifyJws, decodeJws, publicJwk, generateKeyJwk } from './jose.js';
import { notYouth, nextJan1Kst, kstWeekStart } from './age.js';

export const CLAIM_LABELS = {
  name: '이름',
  birthdate: '생년월일',
  not_youth: '청소년 아님(연 나이 기준)',
};

export const AGE_VCT = 'urn:kr:mid:age';
const DAY = 86400;
const nowSec = (ms) => Math.floor(ms / 1000);

export function makeDisclosure(name, value, salt = randomId(16)) {
  return b64uJson([salt, name, value]);
}

export function decodeDisclosure(d) {
  const arr = jsonFromB64u(d);
  if (!Array.isArray(arr) || arr.length !== 3 || typeof arr[0] !== 'string' || typeof arr[1] !== 'string') {
    throw new Error('공개 항목 형식 오류');
  }
  return { salt: arr[0], name: arr[1], value: arr[2] };
}

async function signCredential(claims, { issuer, holderJwk, iat, exp, vct }) {
  const disclosures = [];
  for (const [k, v] of Object.entries(claims)) {
    const encoded = makeDisclosure(k, v);
    disclosures.push({ name: k, value: v, encoded, digest: await sha256(encoded) });
  }
  const payload = {
    iss: issuer.id,
    iat,
    exp,
    vct,
    _sd_alg: 'sha-256',
    _sd: disclosures.map((d) => d.digest).sort(),
    cnf: { jwk: publicJwk(holderJwk) },
  };
  const jwt = await signJws({ typ: 'vc+sd-jwt', kid: issuer.kid }, payload, issuer.jwk);
  return { sdjwt: `${jwt}~${disclosures.map((d) => d.encoded).join('~')}~`, payload, disclosures };
}

/**
 * 신분증 자격증명 발급(이름·생년월일). 봉인 사본(장면 ⑤)에 쓴다. 연령 확인에는 쓰지 않는다.
 * extraClaims: 시험용 추가 항목
 * @returns {Promise<{sdjwt: string, payload: object, disclosures: Array}>}
 */
export async function issueCredential({ name, birthdate, ...extraClaims }, { issuer, holderJwk, now = Date.now(), validDays = 365 }) {
  const iat = nowSec(now);
  return signCredential({ name, birthdate, ...extraClaims }, { issuer, holderJwk, iat, exp: iat + validDays * DAY, vct: 'urn:demo:kr:mobile-resident-id' });
}

/**
 * 연령 전용 1회용 증명 묶음 발급(RFC 9901 §10.1 일괄 발급). 원본 생년월일은 발급기관만 본다.
 * 증명마다 홀더 키·salt가 새것이고, 공개 항목은 not_youth 하나뿐이다. 성명·생년은 넣지 않는다.
 * 비연결성: iat는 발급 주의 월요일 0시(KST), exp는 그로부터 validWeeks주 뒤로, 같은 주에 발급받은 모든 이용자에게 같은 값이다.
 * 값이 false이면 exp는 다음 1월 1일 0시(KST)를 넘지 않는다(이 경계도 모든 이용자에게 같다).
 * @returns {Promise<Array<{sdjwt: string, holderJwk: object}>>}
 */
export async function issueAgeBatch({ birthdate }, { issuer, count = 30, now = Date.now(), validWeeks = AGE_VALID_WEEKS }) {
  const value = notYouth(birthdate, now);
  const iat = kstWeekStart(now);
  const exp = value ? iat + validWeeks * 7 * DAY : Math.min(iat + validWeeks * 7 * DAY, nextJan1Kst(now));
  const out = [];
  for (let i = 0; i < count; i++) {
    const holderJwk = await generateKeyJwk();
    const { sdjwt } = await signCredential({ not_youth: value }, { issuer, holderJwk, iat, exp, vct: AGE_VCT });
    out.push({ sdjwt, holderJwk });
  }
  return out;
}

/** 1회용 증명 유효 주 수. 주 중 어느 날 발급받아도 29~35일 쓸 수 있다 */
export const AGE_VALID_WEEKS = 5;

/** 손님 지갑의 연령 증명 묶음. 한 장은 한 번만 쓴다 */
export class AgeWallet {
  constructor(batch) {
    this.items = batch.map((x) => ({ ...x, used: false }));
  }
  get remaining() { return this.items.filter((x) => !x.used).length; }
  add(batch) { this.items.push(...batch.map((x) => ({ ...x, used: false }))); }
  /** 매장 요청에 답한다. index를 주면 그 증명을 쓰되, 이미 쓴 증명이면 거부한다 */
  async present(request, { now = Date.now(), index } = {}) {
    const i = index ?? this.items.findIndex((x) => !x.used);
    const it = this.items[i];
    if (!it) throw new Error('남은 연령 증명이 없습니다 (새 묶음 필요)');
    if (it.used) throw new Error('이미 쓴 연령 증명입니다 (1회용)');
    it.used = true;
    return createPresentation(it.sdjwt, {
      disclose: request.claims, nonce: request.nonce, aud: request.aud, holderJwk: it.holderJwk, now,
      transactionData: request.transaction_data,
    });
  }
}

export function parseSdJwt(str) {
  if (typeof str !== 'string') throw new Error('문자열이 아닙니다');
  const parts = str.trim().split('~');
  if (parts.length < 2) throw new Error('SD-JWT 구분자(~)가 없습니다');
  const issuerJwt = parts[0];
  const kbJwt = parts[parts.length - 1] || null;
  const disclosures = parts.slice(1, -1).filter(Boolean);
  return { issuerJwt, disclosures, kbJwt };
}

/** 지갑 안 자격증명의 전체 항목(홀더 본인만 보는 값) */
export function readCredential(sdjwt) {
  const { issuerJwt, disclosures } = parseSdJwt(sdjwt);
  const { payload } = decodeJws(issuerJwt);
  const claims = {};
  for (const d of disclosures) {
    const { name, value } = decodeDisclosure(d);
    claims[name] = value;
  }
  return { payload, claims };
}

/**
 * 제시물(VP) 생성: 요청 항목만 남기고 KB-JWT로 홀더 키 바인딩.
 * extra: KB-JWT에 추가할 필드(봉인 사본의 purpose, exp 등)
 */
export async function createPresentation(sdjwt, { disclose, nonce, aud, holderJwk, now = Date.now(), extra = {}, transactionData }) {
  const { issuerJwt, disclosures } = parseSdJwt(sdjwt);
  const chosen = disclosures.filter((d) => disclose.includes(decodeDisclosure(d).name));
  const base = `${issuerJwt}~${chosen.map((d) => d + '~').join('')}`;
  const td = {};
  if (Array.isArray(transactionData) && transactionData.length) {
    // OpenID4VP 1.0 B.3.3.1: 요청의 transaction_data 문자열(base64url) 각각의 해시
    td.transaction_data_hashes = await Promise.all(transactionData.map((x) => sha256(x)));
    td.transaction_data_hashes_alg = 'sha-256';
  }
  const kb = await signJws(
    { typ: 'kb+jwt' },
    { iat: nowSec(now), aud, nonce, sd_hash: await sha256(base), ...td, ...extra },
    holderJwk,
  );
  return base + kb;
}

export const CHECKS = {
  format: '형식 (SD-JWT + 홀더 서명)',
  issuer_sig: '발급기관 서명',
  validity: '자격증명 유효기간',
  disclosure: '선택공개 해시 일치',
  holder_binding: '홀더 키 바인딩',
  audience: '수신자 일치',
  nonce: '요청 nonce (1회용)',
  freshness: '제시 시각',
  tx_binding: '판매 거래 결합 (transaction_data)',
  claim: '요청 항목 포함',
};

/**
 * 제시물 검증. 예외를 던지지 않고 항상 보고서를 돌려준다.
 * opts.issuerJwk 또는 opts.issuerKeys({kid: jwk}, 신뢰 목록. 헤더 kid로 고른다)
 * opts.nonceCheck(nonce) -> 'ok' | 'unknown' | 'used' | 'expired'  (없으면 nonce 검사 생략: 봉인 사본·영수증 재검증)
 * opts.expectedTd: 기대하는 transaction_data 문자열, 또는 nonce -> 문자열 함수. 주면 tx_binding 검사
 * opts.validityAtKbIat: 증명 유효기간을 now가 아니라 홀더 서명 시각(kb.iat)으로 판정 (단속은 증명 만료 뒤에도 하므로)
 * opts.requireKbExp: KB-JWT의 exp를 기한으로 검사 (봉인 사본)
 */
export async function verifyPresentation(vp, opts) {
  const {
    issuerJwk, issuerKeys, expectedAud, requiredClaims = [], nonceCheck = null,
    now = Date.now(), maxAgeSec = 300, requireKbExp = false, expectedTd, validityAtKbIat = false,
  } = opts;
  const t0 = performance.now();
  const timings = {};
  const checks = [];
  const report = { ok: false, checks, timings, claims: {}, kb: null, discarded: [] };
  let mark = t0;
  const lap = (k) => { const t = performance.now(); timings[k] = (timings[k] || 0) + (t - mark); mark = t; };
  const pass = (id, detail = '') => checks.push({ id, label: CHECKS[id] || id, ok: true, detail });
  const fail = (id, detail) => {
    checks.push({ id, label: CHECKS[id] || id, ok: false, detail });
    report.failed = id;
    report.reason = detail;
    timings.total = performance.now() - t0;
    return report;
  };

  // 1. 형식
  let parsed, issuer, kb;
  try {
    parsed = parseSdJwt(vp);
    issuer = decodeJws(parsed.issuerJwt);
    if (!parsed.kbJwt) throw new Error('홀더 서명(KB-JWT)이 없습니다');
    kb = decodeJws(parsed.kbJwt);
    if (issuer.header.typ !== 'vc+sd-jwt') throw new Error('발급기관 JWT 유형이 아닙니다');
    if (kb.header.typ !== 'kb+jwt') throw new Error('KB-JWT 유형이 아닙니다');
  } catch (e) {
    lap('parse');
    return fail('format', `서명된 제시물이 아닙니다: ${e.message}`);
  }
  pass('format', `공개 항목 ${parsed.disclosures.length}개`);
  lap('parse');

  // 2. 발급기관 서명
  const trusted = issuerKeys ? issuerKeys[issuer.header.kid] : issuerJwk;
  if (!trusted || !(await verifyJws(parsed.issuerJwt, trusted))) {
    lap('issuer_sig');
    return fail('issuer_sig', '신뢰하는 발급기관 키로 서명되지 않았습니다');
  }
  pass('issuer_sig', `kid=${issuer.header.kid || '-'}`);
  lap('issuer_sig');

  const p = issuer.payload;
  const nowS = nowSec(now);
  const vAt = validityAtKbIat ? kb.payload.iat : nowS;
  if (typeof vAt !== 'number' || typeof p.exp !== 'number' || p.exp < vAt) {
    return fail('validity', validityAtKbIat ? '제시 당시 이미 유효기간이 지난 증명입니다' : '자격증명 유효기간이 지났습니다');
  }
  if (typeof p.iat === 'number' && vAt < p.iat) return fail('validity', '발급 전에 서명된 제시물입니다');
  pass('validity', `~${new Date(p.exp * 1000).toISOString().slice(0, 10)}${validityAtKbIat ? ' (제시 시각 기준)' : ''}`);

  // 3. 선택공개 해시
  const seen = new Set();
  for (const d of parsed.disclosures) {
    let dec;
    try { dec = decodeDisclosure(d); } catch (e) { lap('disclosure'); return fail('disclosure', e.message); }
    const digest = await sha256(d);
    if (!Array.isArray(p._sd) || !p._sd.includes(digest)) {
      lap('disclosure');
      return fail('disclosure', `「${CLAIM_LABELS[dec.name] || dec.name}」 항목의 해시가 발급 당시 값과 다릅니다 (변조)`);
    }
    if (seen.has(digest)) { lap('disclosure'); return fail('disclosure', '같은 항목이 중복 제시되었습니다'); }
    seen.add(digest);
    if (requiredClaims.length === 0 || requiredClaims.includes(dec.name)) report.claims[dec.name] = dec.value;
    else report.discarded.push(dec.name); // 요청하지 않은 항목은 보관·표시하지 않음
  }
  pass('disclosure', `${parsed.disclosures.length}개 일치`);
  lap('disclosure');

  // 4. 홀더 키 바인딩
  const holderJwk = p.cnf && p.cnf.jwk;
  const base = vp.trim().slice(0, vp.trim().length - parsed.kbJwt.length);
  if (!holderJwk || !(await verifyJws(parsed.kbJwt, holderJwk))) {
    lap('holder_binding');
    return fail('holder_binding', '자격증명 주인의 기기 키로 서명되지 않았습니다 (탈취·복사 의심)');
  }
  if (kb.payload.sd_hash !== (await sha256(base))) {
    lap('holder_binding');
    return fail('holder_binding', '홀더 서명 이후 제시 내용이 바뀌었습니다');
  }
  pass('holder_binding', '기기 키 서명 일치');
  lap('holder_binding');
  report.kb = kb.payload;

  // 5. 수신자·nonce·시각
  if (expectedAud && kb.payload.aud !== expectedAud) {
    return fail('audience', `다른 수신자(${kb.payload.aud})에게 만든 제시물입니다`);
  }
  pass('audience', String(kb.payload.aud));

  if (nonceCheck) {
    const st = nonceCheck(kb.payload.nonce);
    const msg = { unknown: '이 검증기가 발행한 요청이 아닙니다 (캡처·재사용 의심)', used: '이미 사용된 요청입니다 (재사용)', expired: '요청 유효시간이 지났습니다' };
    if (st !== 'ok') { lap('nonce'); return fail('nonce', msg[st] || st); }
    pass('nonce', '발행 후 미사용');
    if (typeof kb.payload.iat !== 'number' || Math.abs(nowS - kb.payload.iat) > maxAgeSec) {
      lap('nonce');
      return fail('freshness', `제시 시각이 허용 범위(${maxAgeSec}초) 밖입니다`);
    }
    pass('freshness', `${nowS - kb.payload.iat}초 전 서명`);
  }
  if (requireKbExp) {
    if (typeof kb.payload.exp !== 'number') return fail('freshness', '제출 기한이 없습니다');
    if (kb.payload.exp < nowS) return fail('freshness', `제출 기한(${new Date(kb.payload.exp * 1000).toLocaleString('ko-KR')})이 지나 무효입니다`);
    pass('freshness', `기한 ${new Date(kb.payload.exp * 1000).toLocaleString('ko-KR')}까지`);
  }
  lap('nonce');

  if (expectedTd !== undefined) {
    const td = typeof expectedTd === 'function' ? expectedTd(kb.payload.nonce) : expectedTd;
    const hashes = kb.payload.transaction_data_hashes;
    if (typeof td !== 'string' || !td) return fail('tx_binding', '판매 거래 정보가 없는 요청입니다');
    if (!Array.isArray(hashes) || !hashes.includes(await sha256(td))) {
      return fail('tx_binding', '손님 서명에 묶인 판매 거래가 이 거래와 다릅니다');
    }
    pass('tx_binding', 'transaction_data_hashes 일치');
  }

  for (const c of requiredClaims) {
    if (!(c in report.claims)) return fail('claim', `「${CLAIM_LABELS[c] || c}」 항목이 없습니다`);
  }
  pass('claim', requiredClaims.map((c) => CLAIM_LABELS[c] || c).join(', ') || '-');

  report.ok = true;
  timings.total = performance.now() - t0;
  return report;
}
