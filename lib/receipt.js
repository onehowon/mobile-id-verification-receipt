// 영수증 공통: 매장 인증서(등록기관이 서명), 보관 기한, 개인정보 패턴.
// 영수증 발급·검증은 receipt2.js(v2: 손님 1회용 제시물 + 매장 서명 + 공통기반 원장)에 있다.
import { signJws, publicJwk } from './jose.js';

const DAY = 86400;
const nowSec = (ms) => Math.floor(ms / 1000);
export const RETENTION_DAYS = 90;

export async function createStoreCert({ storeId, storeName, storeJwk }, registry, { now = Date.now(), validDays = 365 } = {}) {
  const iat = nowSec(now);
  return signJws(
    { typ: 'store-cert+jwt', kid: registry.kid },
    { iss: registry.id, sub: storeId, name: storeName, jwk: publicJwk(storeJwk), iat, exp: iat + validDays * DAY },
    registry.jwk,
  );
}

// 개인정보로 보이는 값 탐지(방어적 점검). 생년월일, 주민등록번호, 전화번호 패턴.
export const PII_PATTERNS = [
  [/\b(19|20)\d{2}[-.]?(0[1-9]|1[0-2])[-.]?(0[1-9]|[12]\d|3[01])\b/, '생년월일 형태'],
  [/\d{6}-?[1-4]\d{6}/, '주민등록번호 형태'],
  [/01[016789]-?\d{3,4}-?\d{4}/, '전화번호 형태'],
];
