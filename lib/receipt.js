// 검증 결과 영수증: 매장 키로 서명한 JWS. 개인정보 없이 결과·시각·매장·목적·제시물 해시만 담는다.
// 매장 키는 검증앱 등록기관(가상 행안부)이 서명한 매장 인증서(scert)로 신뢰를 잇는다.
import { signJws, verifyJws, decodeJws, publicJwk, sha256, randomId } from './jose.js';

const DAY = 86400;
const nowSec = (ms) => Math.floor(ms / 1000);
export const RETENTION_DAYS = 90;

// 영수증 payload에 허용되는 필드. 이 밖의 필드가 있으면 형식 오류로 본다.
export const RECEIPT_FIELDS = {
  ver: '형식 버전',
  rid: '영수증 번호(무작위)',
  result: '결과 (Y/N)',
  claim: '확인 항목',
  purpose: '확인 목적',
  store: '매장 ID',
  iat: '검증 시각',
  exp: '파기 예정 (90일)',
  vp_hash: '제시물 해시 (SHA-256)',
};

export async function createStoreCert({ storeId, storeName, storeJwk }, registry, { now = Date.now(), validDays = 365 } = {}) {
  const iat = nowSec(now);
  return signJws(
    { typ: 'store-cert+jwt', kid: registry.kid },
    { iss: registry.id, sub: storeId, name: storeName, jwk: publicJwk(storeJwk), iat, exp: iat + validDays * DAY },
    registry.jwk,
  );
}

export async function issueReceipt({ vp, result, claim, purpose, storeId }, { storeJwk, storeCert, now = Date.now(), retentionDays = RETENTION_DAYS }) {
  if (result !== 'Y' && result !== 'N') throw new Error('result는 Y 또는 N');
  const iat = nowSec(now);
  const payload = {
    ver: 1,
    rid: randomId(9),
    result,
    claim,
    purpose,
    store: storeId,
    iat,
    exp: iat + retentionDays * DAY,
    vp_hash: await sha256(vp.trim()),
  };
  return signJws({ typ: 'vreceipt+jwt', scert: storeCert }, payload, storeJwk);
}

// 개인정보로 보이는 값 탐지(방어적 점검). 생년월일, 주민등록번호, 전화번호 패턴.
const PII_PATTERNS = [
  [/\b(19|20)\d{2}[-.]?(0[1-9]|1[0-2])[-.]?(0[1-9]|[12]\d|3[01])\b/, '생년월일 형태'],
  [/\d{6}-?[1-4]\d{6}/, '주민등록번호 형태'],
  [/01[016789]-?\d{3,4}-?\d{4}/, '전화번호 형태'],
];

export const RECEIPT_CHECKS = {
  format: '형식',
  store_cert: '매장 인증서 (등록기관 서명)',
  store_sig: '매장 서명',
  fields: '개인정보 미포함',
  retention: '보관 기한 (90일)',
};

export async function verifyReceipt(jws, { registryJwk, now = Date.now() }) {
  const checks = [];
  const report = { ok: false, checks, payload: null, store: null };
  const pass = (id, detail = '') => checks.push({ id, label: RECEIPT_CHECKS[id], ok: true, detail });
  const fail = (id, detail) => { checks.push({ id, label: RECEIPT_CHECKS[id], ok: false, detail }); report.failed = id; report.reason = detail; return report; };

  let d;
  try {
    d = decodeJws(String(jws).trim());
    if (d.header.typ !== 'vreceipt+jwt') throw new Error('영수증 유형(vreceipt+jwt)이 아닙니다');
    if (!d.header.scert) throw new Error('매장 인증서가 없습니다');
  } catch (e) {
    return fail('format', e.message);
  }
  report.payload = d.payload;
  pass('format', 'JWS ES256');

  let cert;
  try { cert = decodeJws(d.header.scert); } catch (e) { return fail('store_cert', '매장 인증서 형식 오류'); }
  if (!(await verifyJws(d.header.scert, registryJwk))) return fail('store_cert', '등록기관이 서명한 매장 인증서가 아닙니다');
  if (cert.payload.exp < nowSec(now)) return fail('store_cert', '매장 인증서 기한 만료');
  if (cert.payload.sub !== d.payload.store) return fail('store_cert', '영수증의 매장 ID와 인증서가 다릅니다');
  report.store = { id: cert.payload.sub, name: cert.payload.name };
  pass('store_cert', `${cert.payload.name} (${cert.payload.sub})`);

  if (!(await verifyJws(String(jws).trim(), cert.payload.jwk))) return fail('store_sig', '매장 서명이 맞지 않습니다 (영수증 변조)');
  pass('store_sig', '일치');

  const extra = Object.keys(d.payload).filter((k) => !(k in RECEIPT_FIELDS));
  if (extra.length) return fail('fields', `허용되지 않은 필드: ${extra.join(', ')}`);
  for (const [k, v] of Object.entries(d.payload)) {
    if (k === 'iat' || k === 'exp') continue;
    for (const [re, label] of PII_PATTERNS) {
      if (re.test(String(v))) return fail('fields', `${k} 값이 ${label}입니다`);
    }
  }
  pass('fields', `필드 ${Object.keys(d.payload).length}개, 모두 허용 목록`);

  if (d.payload.exp < nowSec(now)) return fail('retention', `보관 기한(${new Date(d.payload.exp * 1000).toLocaleDateString('ko-KR')})이 지나 파기 대상입니다`);
  pass('retention', `${new Date(d.payload.exp * 1000).toLocaleDateString('ko-KR')}까지`);

  report.ok = true;
  return report;
}
