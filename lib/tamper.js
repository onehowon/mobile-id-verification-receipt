// 위조 시연용 공격 생성기. 모두 "공격자가 할 수 있는 일"만 한다(발급기관·홀더 개인키는 쓰지 않음).
import { generateKeyJwk, decodeJws } from './jose.js';
import { parseSdJwt, decodeDisclosure, makeDisclosure, issueCredential, createPresentation } from './sdjwt.js';

export const ATTACKS = {
  birth: {
    title: '생년·연령 변조',
    desc: '미성년자의 제시물에서 공개 항목 값을 「만 19세 이상 = 예」로 고쳐 쓴다. 화면 캡처의 생년월일을 고치는 것과 같은 공격.',
    expect: 'disclosure',
  },
  forge: {
    title: '서명 위조 (가짜 신분증 앱)',
    desc: '위조 앱이 자기 키로 「성인」 자격증명을 만들어 제시한다. 형식·홀더 서명·nonce는 모두 정상이지만 발급기관 키가 다르다.',
    expect: 'issuer_sig',
  },
  replay: {
    title: '재사용 nonce (캡처 QR 재제시)',
    desc: '다른 사람이 이미 한 번 쓴 QR을 캡처해 다시 보여준다.',
    expect: 'nonce',
  },
  stolen: {
    title: '탈취한 자격증명 (홀더 키 없음)',
    desc: '남의 자격증명을 복사해 새 요청에 맞춰 자기 키로 서명한다.',
    expect: 'holder_binding',
  },
};

/** 미성년자 제시물의 age_over_19 공개값을 true로 바꾼다(같은 salt 유지). KB-JWT는 그대로 둔다. */
export function tamperBirth(vp) {
  const { issuerJwt, disclosures, kbJwt } = parseSdJwt(vp);
  const forged = disclosures.map((d) => {
    const { salt, name, value } = decodeDisclosure(d);
    if (name === 'age_over_19') return makeDisclosure(name, true, salt);
    if (name === 'birthdate') return makeDisclosure(name, '2000-01-01', salt);
    return d;
  });
  return `${issuerJwt}~${forged.map((d) => d + '~').join('')}${kbJwt}`;
}

/** 위조 발급기관 키로 만든 자체 일관 제시물. 발급기관 id·kid는 진짜처럼 흉내 낸다. */
export async function forgeWithFakeIssuer({ issuer, nonce, aud, now = Date.now() }) {
  const fakeIssuer = { id: issuer.id, kid: issuer.kid, jwk: await generateKeyJwk() };
  const holderJwk = await generateKeyJwk();
  const { sdjwt } = await issueCredential({ name: '홍길동', birthdate: '1990-01-01' }, { issuer: fakeIssuer, holderJwk, now });
  return createPresentation(sdjwt, { disclose: ['age_over_19'], nonce, aud, holderJwk, now });
}

/** 남의 제시물에서 발급기관 JWT·공개 항목을 떼어 와 공격자 키로 KB-JWT를 만든다. */
export async function stealAndRebind(victimVp, { nonce, aud, now = Date.now() }) {
  const { issuerJwt, disclosures } = parseSdJwt(victimVp);
  const sdjwt = `${issuerJwt}~${disclosures.map((d) => d + '~').join('')}`;
  return createPresentation(sdjwt, { disclose: disclosures.map((d) => decodeDisclosure(d).name), nonce, aud, holderJwk: await generateKeyJwk(), now });
}

export function describeVp(vp) {
  const { issuerJwt, disclosures, kbJwt } = parseSdJwt(vp);
  return {
    issuer: decodeJws(issuerJwt).payload,
    disclosures: disclosures.map(decodeDisclosure),
    kb: kbJwt ? decodeJws(kbJwt).payload : null,
  };
}
