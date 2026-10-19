import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { SCENES, BEAT_COUNT } from '../lib/scenes.js';
import { matchScannedRequest, homography, project } from '../lib/scan.js';
import { setupDemo, newRequest, runAdultCheck } from '../lib/demo-flow.js';

const NOW = Date.parse('2026-10-19T21:42:00+09:00');

describe('QR 촬영 단계', () => {
  let ctx, req;
  before(async () => {
    ctx = await setupDemo({ now: NOW });
    req = newRequest(ctx, { now: NOW });
  });

  test('장면 ①은 [성인 확인] → QR 촬영 → 동의 → 결과, 전체 15조각', () => {
    const adult = SCENES[0];
    assert.equal(adult.beats.length, 4);
    assert.equal(adult.beats.findIndex((b) => b.scan), 1);
    assert.equal(adult.beats[1].focus, 'left');
    assert.equal(SCENES.flatMap((s) => s.beats).filter((b) => b.scan).length, 1);
    assert.equal(BEAT_COUNT, 15);
  });

  test('요청에는 1회용 번호와 유효시간(120초)이 들어 있다', () => {
    assert.equal(typeof req.nonce, 'string');
    assert.equal(req.exp, Math.floor(NOW / 1000) + 120);
  });

  test('매장이 띄운 요청을 그대로 읽으면 일치', () => {
    const r = matchScannedRequest(JSON.stringify(req), req, { now: NOW + 5000 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.req, req);
  });

  test('다른 1회용 번호·다른 매장·다른 항목·시간 지남·형식 불량은 넘어가지 않는다', () => {
    const other = newRequest(ctx, { now: NOW });
    const cases = [
      [JSON.stringify(other), '1회용 번호'],
      [JSON.stringify({ ...req, aud: 'STORE-OTHER' }), '다른 매장'],
      [JSON.stringify({ ...req, claims: ['age_over_19', 'name'] }), '확인 항목'],
      [JSON.stringify({ ...req, purpose: '다른 목적' }), '요청 내용'],
      ['not json', '형식'],
      [JSON.stringify({ hello: 1 }), '형식'],
      [null, '읽지 못했어요'],
    ];
    for (const [text, why] of cases) {
      const r = matchScannedRequest(text, req, { now: NOW });
      assert.equal(r.ok, false, String(text));
      assert.ok(r.reason.includes(why), `${r.reason} / ${why}`);
      assert.ok(r.reason.endsWith('요'));
    }
    assert.equal(matchScannedRequest(JSON.stringify(req), req, { now: NOW + 121000 }).ok, false);
  });

  test('읽은 요청으로 답한 제시물은 매장 검증을 통과한다', async () => {
    const read = matchScannedRequest(JSON.stringify(req), req, { now: NOW });
    const r = await runAdultCheck(ctx, { now: NOW, request: read.req });
    assert.equal(r.out.report.ok, true);
    assert.equal(r.out.result, 'Y');
  });

  test('카메라 사진용 원근 변환은 네 모서리를 정확히 옮긴다', () => {
    const src = [[75, 182], [315, 182], [315, 422], [75, 422]];
    const dst = [[200, 600], [570, 620], [590, 1040], [180, 1020]];
    const H = homography(src, dst);
    src.forEach(([x, y], i) => {
      const [u, v] = project(H, x, y);
      assert.ok(Math.abs(u - dst[i][0]) < 1e-6 && Math.abs(v - dst[i][1]) < 1e-6);
    });
    const [cx, cy] = project(H, 195, 302);
    assert.ok(cx > 180 && cx < 590 && cy > 600 && cy < 1040);
  });
});
