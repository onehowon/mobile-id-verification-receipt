import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

import { SCENES, TOTAL_MS, BEAT_COUNT, nextPos, prevPos, beatIndex, posFromQuery, failureCopy, formatKst } from '../lib/scenes.js';
import { setupDemo, runAdultCheck, runAttack, runAudit, runOwnerForgery, runBenchmark, runSealed, measureStages, ATTACK_KINDS, PEOPLE } from '../lib/demo-flow.js';
import { decodeJws } from '../lib/jose.js';
import { toCsv } from '../lib/measure.js';

const NOW = Date.parse('2026-10-19T21:42:00+09:00');

describe('장면 진행', () => {
  test('다음/이전으로 모든 장면 조각을 한 번씩 지나고 끝에서 멈춘다', () => {
    let p = { s: 0, b: 0 };
    let n = 1;
    while (nextPos(p)) { p = nextPos(p); n++; assert.equal(beatIndex(p), n); }
    assert.equal(n, BEAT_COUNT);
    assert.equal(p.s, SCENES.length - 1);
    while (prevPos(p)) p = prevPos(p);
    assert.deepEqual(p, { s: 0, b: 0 });
  });

  test('자동 재생은 약 2분, 문구는 「~요」체', () => {
    assert.ok(TOTAL_MS >= 110000 && TOTAL_MS <= 130000, `${TOTAL_MS}ms`);
    for (const s of SCENES) for (const b of s.beats) {
      assert.match(b.narr, /요\.$/, b.narr);
      assert.doesNotMatch(b.narr, /니다/, b.narr);
    }
  });

  test('주소 쿼리는 범위 밖 값을 잘라 낸다', () => {
    assert.deepEqual(posFromQuery('?scene=3&beat=2'), { s: 2, b: 1 });
    assert.deepEqual(posFromQuery('?scene=99&beat=-4'), { s: SCENES.length - 1, b: 0 });
    assert.deepEqual(posFromQuery(''), { s: 0, b: 0 });
  });

  test('한국 시각 표기는 기기 시간대와 무관하다', () => {
    assert.equal(formatKst(NOW), '2026.10.19 21:42');
    assert.equal(formatKst(NOW, { time: false }), '2026.10.19');
  });
});

describe('장면 흐름 (실제 서명·검증)', () => {
  let ctx, adult;
  before(async () => {
    ctx = await setupDemo({ now: NOW });
    adult = await runAdultCheck(ctx, { now: NOW });
  });

  test('① 연령 확인: Y + 영수증 + 원장 기록, 청소년 아님만 보내고 이름·생년월일은 보내지 않음', () => {
    assert.equal(adult.out.result, 'Y');
    assert.ok(adult.out.anchor, '공통기반 원장 기록');
    assert.match(adult.posTxId, /^POS-20261019-\d{4}$/);
    assert.deepEqual(adult.sent, ['not_youth']);
    assert.deepEqual(adult.withheld.sort(), ['birthdate', 'name']);
    assert.ok(!adult.vp.includes(PEOPLE.adult.name));
    const { payload } = decodeJws(adult.out.receipt);
    assert.equal(payload.result, 'Y');
    assert.ok(!JSON.stringify(payload).includes(PEOPLE.adult.birthdate));
  });

  test('② 위조 3종은 각각 다른 검사에서 막히고 영수증이 없다', async () => {
    const expect = { birth: 'disclosure', forge: 'issuer_sig', replay: 'nonce' };
    for (const kind of ATTACK_KINDS) {
      const r = await runAttack(ctx, kind, { now: NOW, usedVp: adult.vp });
      assert.equal(r.out.report.ok, false, kind);
      assert.equal(r.out.report.failed, expect[kind], kind);
      assert.equal(r.out.receipt, null);
      assert.ok(failureCopy(r.out.report).head.endsWith('요'));
    }
    const replay = await runAttack(ctx, 'replay', { now: NOW, usedVp: adult.vp });
    assert.equal(failureCopy(replay.out.report).head, '이미 사용한 QR이에요');
  });

  test('③ 약 3개월 뒤에도 영수증이 15단계 모두 통과한다', async () => {
    const { report, at } = await runAudit(ctx, adult);
    assert.equal(report.ok, true, report.reason);
    assert.equal(report.checks.length, 15);
    assert.ok(at > NOW + 80 * 86400000);
  });

  test('③ 대비: 업주가 만든 영수증 2종(가짜 증명, N→Y)은 원장에 올려도 거부된다', async () => {
    const o = await runOwnerForgery(ctx, adult);
    assert.equal(o.fakeIssuer.report.failed, 'issuer_sig');
    assert.equal(o.flip.original, 'N');
    assert.equal(o.flip.report.failed, 'result');
  });

  test('④ 측정 30회와 CSV', async () => {
    const sum = await runBenchmark(ctx, 30);
    assert.equal(sum.n, 30);
    assert.ok(sum.median > 0);
    assert.ok(toCsv(ctx.measures).split('\n').length > 30);
    const rows = await measureStages(ctx, { n: 2 }); // 기기 측정(scripts/measure.mjs)과 같은 함수, Node에서는 QR 디코드 없이
    assert.equal(rows.length, 2);
    for (const r of rows) for (const k of ['issuer_sig', 'store_verify', 'receipt_sign', 'audit_15']) assert.ok(r[k] >= 0, k);
  });

  test('⑤ 봉인 사본: 기한 안 유효, 기한 뒤 무효', async () => {
    const r = await runSealed(ctx, { now: NOW });
    assert.equal(r.valid.ok, true);
    assert.equal(r.expired.ok, false);
    assert.equal(r.expired.failed, 'freshness');
  });
});

describe('큰 글씨 모드', () => {
  test('?large=1 로 켜고, 없거나 다른 값이면 꺼진다', async () => {
    const { largeFromQuery } = await import('../lib/scenes.js');
    assert.equal(largeFromQuery('?scene=1&large=1'), true);
    assert.equal(largeFromQuery('?large=true'), true);
    assert.equal(largeFromQuery('?scene=1'), false);
    assert.equal(largeFromQuery('?large=0'), false);
  });

  test('자막 덧붙임은 장면 ① 동의 단계에만, 큰 글씨 모드일 때만 한 줄', async () => {
    const { narration } = await import('../lib/scenes.js');
    const withExtra = SCENES.flatMap((s, si) => s.beats.map((b, bi) => ({ si, bi, b }))).filter((x) => x.b.narrLarge);
    assert.deepEqual(withExtra.map((x) => [x.si, x.bi]), [[0, 2]]);
    const beat = withExtra[0].b;
    assert.equal(narration(beat).extra, '');
    assert.equal(narration(beat, { large: true }).extra, beat.narrLarge);
    assert.match(beat.narrLarge, /요\.$/);
    assert.doesNotMatch(beat.narrLarge, /\n|누구나|완벽|반드시/);
    assert.equal(narration(SCENES[0].beats[0], { large: true }).extra, '');
  });

  test('큰 글씨 모드 색은 모두 대비 7:1 이상', async () => {
    const { LARGE_PAIRS, LARGE_TARGET, contrastRatio } = await import('../lib/contrast.js');
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.equal(contrastRatio('#fff', '#fff'), 1);
    assert.equal(contrastRatio('#6d7882', '#ffffff'), 4.5); // 기본 모드 보조 글자 (AA 경계)
    for (const p of LARGE_PAIRS) assert.ok(contrastRatio(p.fg, p.bg) >= LARGE_TARGET, `${p.use} ${contrastRatio(p.fg, p.bg)}`);
  });
});
