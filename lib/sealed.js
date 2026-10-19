// 확장: 목적·기한이 묶인 봉인 사본 (공공기관 제출용).
// 신분증 사진 대신, 수신기관(aud)·목적·기한(exp)을 홀더가 서명에 묶은 제시물을 낸다. 기한이 지나면 무효.
import { randomId } from './jose.js';
import { createPresentation, verifyPresentation } from './sdjwt.js';

export async function createSealedCopy(sdjwt, { disclose, recipient, purpose, expiresAt, holderJwk, now = Date.now() }) {
  const jti = randomId(9);
  const token = await createPresentation(sdjwt, {
    disclose,
    aud: recipient,
    nonce: jti,
    holderJwk,
    now,
    extra: { purpose, exp: Math.floor(expiresAt / 1000), jti },
  });
  return { token, jti };
}

export async function verifySealedCopy(token, { issuerJwk, recipient, now = Date.now(), revoked = [] }) {
  const report = await verifyPresentation(token, {
    issuerJwk,
    expectedAud: recipient,
    requireKbExp: true,
    now,
  });
  if (report.ok && revoked.includes(report.kb.jti)) {
    report.ok = false;
    report.failed = 'revoked';
    report.reason = '제출자가 철회한 사본입니다';
    report.checks.push({ id: 'revoked', label: '철회 여부', ok: false, detail: report.reason });
  } else if (report.ok) {
    report.checks.push({ id: 'revoked', label: '철회 여부', ok: true, detail: '철회되지 않음' });
  }
  return report;
}
