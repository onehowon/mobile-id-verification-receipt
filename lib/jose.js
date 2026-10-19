// base64url, SHA-256, ES256 JWS. 브라우저와 Node(globalThis.crypto) 공용.
const subtle = globalThis.crypto.subtle;
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64uEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64uDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('base64url 형식이 아닙니다');
  const p = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(p + '==='.slice((p.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export const b64uJson = (obj) => b64uEncode(enc.encode(JSON.stringify(obj)));
export const jsonFromB64u = (s) => JSON.parse(dec.decode(b64uDecode(s)));

export async function sha256(str) {
  return b64uEncode(new Uint8Array(await subtle.digest('SHA-256', enc.encode(str))));
}

export function randomId(bytes = 16) {
  return b64uEncode(globalThis.crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function generateKeyJwk() {
  const kp = await subtle.generateKey(ALG, true, ['sign', 'verify']);
  const j = await subtle.exportKey('jwk', kp.privateKey);
  return { kty: j.kty, crv: j.crv, x: j.x, y: j.y, d: j.d };
}

export const publicJwk = (jwk) => ({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });

async function importKey(jwk, use) {
  const k = use === 'sign' ? { ...publicJwk(jwk), d: jwk.d } : publicJwk(jwk);
  return subtle.importKey('jwk', k, ALG, false, [use]);
}

export async function signJws(header, payload, privateJwk) {
  const input = `${b64uJson({ alg: 'ES256', ...header })}.${b64uJson(payload)}`;
  const sig = await subtle.sign(SIGN, await importKey(privateJwk, 'sign'), enc.encode(input));
  return `${input}.${b64uEncode(new Uint8Array(sig))}`;
}

// 서명 검증 없이 구조만 해석. 형식 오류면 throw.
export function decodeJws(jws) {
  if (typeof jws !== 'string') throw new Error('문자열이 아닙니다');
  const parts = jws.split('.');
  if (parts.length !== 3) throw new Error('JWS는 점(.)으로 구분된 3부분이어야 합니다');
  const header = jsonFromB64u(parts[0]);
  const payload = jsonFromB64u(parts[1]);
  const signature = b64uDecode(parts[2]);
  return { header, payload, signature, input: `${parts[0]}.${parts[1]}` };
}

export async function verifyJws(jws, publicKeyJwk) {
  const d = decodeJws(jws);
  if (d.header.alg !== 'ES256') return false;
  if (d.signature.length !== 64) return false;
  try {
    return await subtle.verify(SIGN, await importKey(publicKeyJwk, 'verify'), d.signature, enc.encode(d.input));
  } catch {
    return false;
  }
}

export async function jwkThumbprint(jwk) {
  return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
}
