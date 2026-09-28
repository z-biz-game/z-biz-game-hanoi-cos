// The generator: shapes, bands, and the promise that a board built from a seed is the same board
// on every device. The pars asserted here are the hand-typed anchors; the scrambles are asserted
// against their OWN measured distance, which is the whole point of the deviation documented in
// DESIGN.md §5.

import { ok, eq, deepEq, throws, run, section } from '../tools/harness.mjs';
import { goalState, startState, createGame, moveTop, hint, remaining, isExact } from '../js/core/game.js';
import {
  SHAPES, TIERS, bandFor, canScramble, canonicalLevel, dailyLevel, makeLevel, parOf, shapesIn,
  tierByKey, tierOf, scramble,
} from '../js/core/make.js';
import { EXHAUST_LIMIT, TABLE_BUDGET, closedForm3, fsPar, stateCount } from '../js/core/solve.js';
import { hashSeed } from '../js/core/rng.js';

const CANONICAL_3 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const CANONICAL_3_PAR = [1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191];
const FOUR_PEG_SHAPES = [2, 3, 4, 5, 6, 7, 8, 9, 10];
const FOUR_PEG_PAR = [3, 5, 9, 13, 17, 25, 33, 41, 49];

section('make: bands are the spec\'s shape ranges');
for (let n = 1; n <= 4; n++) eq(tierOf(3, n), 'shoal', `3 pegs / ${n} disks is 浅滩`);
for (let n = 5; n <= 7; n++) eq(tierOf(3, n), 'linked', `3 pegs / ${n} disks is 连阶`);
for (let n = 8; n <= 10; n++) eq(tierOf(3, n), 'twined', `3 pegs / ${n} disks is 缠盘`);
for (let n = 11; n <= 13; n++) eq(tierOf(3, n), 'master', `3 pegs / ${n} disks is 绝顶`);
eq(tierOf(3, 14), null, 'fourteen disks on three pegs is 3^14 positions: nothing is offered');
for (let n = 2; n <= 5; n++) eq(tierOf(4, n), 'shoal', `4 pegs / ${n} disks is 浅滩`);
for (let n = 6; n <= 10; n++) eq(tierOf(4, n), 'master', `4 pegs / ${n} disks is 绝顶`);
eq(tierOf(4, 11), null, '4 pegs / 11 disks: FS is published (65) but 4^11 exceeds the cap, so no row');
eq(tierOf(4, 12), null, '4 pegs / 12 disks: same reason (FS 81 stays in test/solve.test.mjs)');
eq(tierOf(5, 4), null, 'five pegs is not a shape this repo takes an opinion about');
eq(tierOf(4, 1), 'shoal', 'one disk on four pegs still belongs to the shallowest band…');
ok(!SHAPES.some((s) => s.pegs === 4 && s.n === 1), '…but it is not shipped as a second row of the same toy');
eq(TIERS.map((t) => t.key).join(','), 'shoal,linked,twined,master', 'four bands');
eq(TIERS.map((t) => t.label).join(''), '浅滩连阶缠盘绝顶', 'and the spec\'s four names');
eq(tierByKey('nonsense').key, 'shoal', 'an unknown band falls back to the shallowest, it never crashes');

section('make: the shape list is exactly the shippable one');
eq(SHAPES.length, 22, '22 shapes: 3 pegs × 13 disks, 4 pegs × 9 usable disks');
deepEq(SHAPES.filter((s) => s.pegs === 3).map((s) => s.n), CANONICAL_3, 'three-peg shapes n=1..13');
deepEq(SHAPES.filter((s) => s.pegs === 4).map((s) => s.n), FOUR_PEG_SHAPES, 'four-peg shapes n=2..10');
ok(SHAPES.every((s) => stateCount(s.n, s.pegs) <= EXHAUST_LIMIT), 'every shipped shape can be exhausted by bake');
ok(!SHAPES.some((s) => s.pegs === 4 && s.n >= 11), 'no shape whose printed par could not be re-solved');
eq(shapesIn('linked').length, 3, '连阶 holds the 5-, 6- and 7-disk towers');

section('make: canonical levels carry the arithmetic AND the measurement');
for (let i = 0; i < CANONICAL_3.length; i++) {
  const lv = canonicalLevel(3, CANONICAL_3[i], `lot-3p-${CANONICAL_3[i]}`);
  eq(lv.par, CANONICAL_3_PAR[i], `3 pegs / ${CANONICAL_3[i]} disks measures ${CANONICAL_3_PAR[i]}`);
  eq(lv.closedForm, CANONICAL_3_PAR[i], `…which is 2^${CANONICAL_3[i]}-1, printed beside it`);
  eq(lv.frameStewart, null, '…and no four-peg claim on a three-peg board');
}
for (let i = 0; i < FOUR_PEG_SHAPES.length; i++) {
  const lv = canonicalLevel(4, FOUR_PEG_SHAPES[i], `lot-4p-${FOUR_PEG_SHAPES[i]}`);
  eq(lv.par, FOUR_PEG_PAR[i], `4 pegs / ${FOUR_PEG_SHAPES[i]} disks measures ${FOUR_PEG_PAR[i]}`);
  eq(lv.frameStewart, FOUR_PEG_PAR[i], '…and the FS value is printed alongside as the arithmetic');
  eq(lv.closedForm, null, '…while the three-peg closed form is left off, not mislabelled');
}
{
  const lv = canonicalLevel(3, 3, 'lot-3p-3');
  eq(lv.id, 'lot-3p-3', 'the id the router uses');
  eq(lv.kind, 'canonical', 'and the kind');
  eq(lv.start, startState(3, 3), 'a canonical board starts as one tower');
  eq(lv.goal, goalState(3, 3), '…and finishes as one tower on the last peg');
  eq(lv.states, 27, 'its state space travels with the row');
  eq(lv.tier, 'shoal', 'its band travels too');
  ok(typeof lv.metrics.remaining === 'function', 'metrics are attached by the same machinery bake used');
  eq(lv.metrics.remaining(lv.start, 0), lv.par, 'and they agree with the printed par');
}

section('make: which shapes may be scrambled, and why');
eq(canScramble({ pegs: 3, n: 13 }), true, '3^13 is still inside the exhaustive cap, so a scramble there is measurable');
eq(canScramble({ pegs: 3, n: 14 }), false, '3^14 is not');
eq(canScramble({ pegs: 4, n: 8 }), true, '4^8 = 65536 is the browser sweep budget');
eq(canScramble({ pegs: 4, n: 9 }), false, 'a four-peg scramble bigger than that has no live distance, so none ships');
eq(canScramble({ pegs: 3, n: 2 }), false, 'a two-disk board cannot hold a puzzle: the longest route is 3 moves');
eq(TIERS.filter((t) => shapesIn(t.key).filter(canScramble).length === 0).length, 0, 'every band has at least one scramble-able shape');

section('make: bands are chosen so a walk can actually reach them');
// Each move changes the distance by exactly 1, so a k-step walk cannot land more than k away.
for (const s of SHAPES) {
  if (!canScramble(s)) continue;
  const b = bandFor(s.pegs, s.n);
  ok(b.parMin < b.parMax, `${s.pegs}p/${s.n}d band is a real interval (${b.parMin}..${b.parMax})`);
  ok(b.parMax <= 60, `${s.pegs}p/${s.n}d band stays shallow enough to be reachable`);
  ok(b.kMax >= b.parMax, `${s.pegs}p/${s.n}d walks are at least as long as the par they ask for (${b.kMax} ≥ ${b.parMax})`);
  ok(b.kMin < b.kMax && b.kMin >= 4, `${s.pegs}p/${s.n}d walk lengths vary (${b.kMin}..${b.kMax})`);
  ok(b.kMax <= 400, `${s.pegs}p/${s.n}d walks stay cheap enough for boot`);
}

section('make: scrambles are legal, measured, deterministic and never too slow');
{
  const stats = {};
  let worstMs = 0;
  let outside = 0;
  let measuredMismatch = 0;
  let notLegal = 0;
  let tooLong = 0;
  for (const t of TIERS) {
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now();
      const lv = makeLevel(`suite|${t.key}|${i}`, t.key, stats);
      const spent = performance.now() - t0;
      worstMs = Math.max(worstMs, spent);
      if (spent > 400) tooLong++;
      const b = bandFor(lv.pegs, lv.n);
      if (lv.par < b.parMin || lv.par > b.parMax) outside++;
      if (lv.par !== parOf(lv.start, lv.pegs, lv.n)) measuredMismatch++;
      if (stateCount(lv.n, lv.pegs) !== lv.states) notLegal++;
    }
  }
  eq(tooLong, 0, `48 boards across all four bands: none took over 400 ms (worst ${worstMs.toFixed(1)} ms)`);
  eq(outside, 0, 'every generated board sits inside its own measured band (or says relaxed)');
  eq(measuredMismatch, 0, 'the printed par is the measured distance of that position — never the closed form');
  eq(notLegal, 0, 'the row\'s state count matches its shape');
  ok(stats.accepted > 0 && stats.tried > stats.accepted, `${stats.accepted}/${stats.tried} walks were accepted straight away; the rest were re-walked`);
  eq(stats.relaxed || 0, 0, 'no board in this run had to be relaxed out of its band');
  const t0 = performance.now();
  const lv = makeLevel('slow|master', 'master');
  const ms = performance.now() - t0;
  ok(ms < 400, `the deepest band generates in ${ms.toFixed(1)} ms — boot stays interactive`);
  eq(lv.attempts >= 1, true, 'the number of walks it took travels with the board');
  eq(lv.kind, 'scramble', 'and it says which kind of board it is');
  ok(lv.band[0] <= lv.par && lv.par <= lv.band[1], 'the band is printed next to the par');
  eq(lv.relaxed, false, 'it was not a fallback pick');
}

section('make: the same seed is the same tower, everywhere');
{
  const a = makeLevel('seed|a', 'twined');
  const b = makeLevel('seed|a', 'twined');
  eq(a.start, b.start, 'same token → same position');
  eq(a.n, b.n, 'same shape');
  eq(a.par, b.par, 'same measured par');
  eq(makeLevel('seed|b', 'twined').start !== a.start || makeLevel('seed|b', 'twined').n !== a.n, true, 'a different token is a different board');
  const sc = scramble('w|same', 3, 6);
  deepEq([sc.par, sc.k], [scramble('w|same', 3, 6).par, scramble('w|same', 3, 6).k], 'the walk itself is a function of the seed');
  const forced = scramble('x', 3, 4, { parMin: 400, parMax: 401, tries: 3 });
  eq(forced.relaxed, true, 'an unreachable band is announced on the board, it never throws at boot');
  ok(forced.par >= 0 && forced.par <= parOf(startState(4, 3), 3, 4), '…and still carries a measured distance');
}

section('make: the daily board is a date, not a database row');
{
  const d1 = dailyLevel('2026-09-27');
  const d2 = dailyLevel('2026-09-27');
  eq(d1.start, d2.start, 'one date, one board, on any device');
  eq(d1.id, 'daily-2026-09-27', 'the id the router shows');
  eq(d1.kind, 'scramble', 'the daily is a scramble, so its par is a measured distance');
  eq(d1.par, parOf(d1.start, d1.pegs, d1.n), '…and it is that distance');
  eq(d1.tier, TIERS[hashSeed('daily|2026-09-27') % TIERS.length].key, 'the band is the hash mod the band count');
  const g = createGame(d1);
  eq(remaining(g), g.par, 'the board opens knowing how far it is from the goal');
  let guard = 0;
  while (!g.done && guard++ < 400) {
    const mv = hint(g);
    moveTop(g, mv.from, mv.to);
  }
  eq(g.moves, g.par, `the daily board plays out in exactly its measured ${g.par} moves`);
  eq(isExact(g), true, 'a three-peg daily is measured exactly at every click');
  const dates = ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2024-02-29'];
  deepEq(dates.map((k) => dailyLevel(k).id), dates.map((k) => `daily-${k}`), 'every date keys its own board');
  ok(new Set(dates.map((k) => `${dailyLevel(k).pegs}|${dailyLevel(k).n}|${dailyLevel(k).start}`)).size > 1, 'successive days are not the same tower');
}

const c = run();
process.exit(c.fails ? 1 : 0);
