// 데모 전용 고정 키. 실제 행안부 키가 아니며, 개인키가 공개되어 있으므로 어떤 실제 용도로도 쓰면 안 된다.
// 고정 키를 쓰는 이유: 휴대폰 두 대(지갑/검증기)로 시연할 때 양쪽이 같은 발급기관 공개키를 신뢰하도록.

// 가상 발급기관(행안부 모바일신분증 발급 역할)
export const ISSUER = {
  id: 'https://issuer.mobileid-demo.invalid',
  kid: 'demo-issuer-2026',
  name: '가상 발급기관 (행안부 역할, 데모)',
  jwk: {
    kty: 'EC', crv: 'P-256',
    x: 'OX76KnNfs7Ghkjj4LLv2jrreLAtvhc1SDZzE4ZxNhGM',
    y: 'Z7az8wFSZP4dVpWbAWdyQCK3c0O39XU8BwLsbXzuNYk',
    d: '-9VTf8jfDVse5DsqnN40d1hOImjgro_xQfcEhBwDPPI',
  },
};

// 가상 검증앱 등록기관: 매장(검증자) 키를 등록하고 인증서를 서명한다.
export const REGISTRY = {
  id: 'https://verifier-registry.mobileid-demo.invalid',
  kid: 'demo-registry-2026',
  name: '가상 검증앱 등록기관 (행안부 역할, 데모)',
  jwk: {
    kty: 'EC', crv: 'P-256',
    x: '1AnCKI8OKwa2KNTZrC4bf1sxPnxzJLIajV3-zEhCTgs',
    y: 'dKR-uvn7CHLejSx7N8so_2HT2v-peVNWr_4cjR8DUG0',
    d: 'iNJDRuhHanxyjjEaVk9uLVrxzc1Q7wycdckRIJBlbOs',
  },
};

// 가상 공통기반 「검증 사실 원장」: 영수증 해시에 시각 확인을 서명한다 (전자정부법 시행령 제12조의4 제2항 제3호의 업무를 흉내 냄).
export const LEDGER = {
  id: 'https://ledger.mobileid-demo.invalid',
  kid: 'demo-ledger-2026',
  name: '가상 공통기반 검증 사실 원장 (행안부 역할, 데모)',
  jwk: {
    kty: 'EC', crv: 'P-256',
    x: 'G5Ud50W5g53FApqnM-Vb1iqqOUnO2Gz2ZGzEAJIDGGw',
    y: 'tsOnrA1os3xYlut1F2ohJadsvgC6aCdPGR73qwCEIIY',
    d: 'bJEYzm1hJQQBsIdiL9rCmiTeDDH8aFq17yAd0e6bzZw',
  },
};

/** 신뢰하는 발급기관 공개키 목록 (kid → 공개키) */
export const ISSUER_KEYS = { [ISSUER.kid]: { kty: ISSUER.jwk.kty, crv: ISSUER.jwk.crv, x: ISSUER.jwk.x, y: ISSUER.jwk.y } };
