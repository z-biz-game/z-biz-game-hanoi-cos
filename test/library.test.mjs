// The baked table, re-proved. Nothing here trusts js/data/lots.js: every printed par is
// re-measured with an exhaustive sweep of that row's own graph, and the campaign order, the
// band bookkeeping and the row format are all checked against hand-typed expectations.

import { ok, eq, deepEq, run, section } from '../tools/harness.mjs';
import { createGame, isExact, moveTop, hint, remaining, goalState, startState } from '../js/core/game.js';
import {
  BAKE, LOTS, LOTS_VERSION, TIERS_META, afterId, bands, browserSweepable, byId, campaign,
  dailyBand, dailyBoard, describe, firstRow, maxStates, randomLevel, rowExhaustive, rowList,
  stats, verifyAll, verifySummary,
} from '../js/core/library.js';
import { EXHAUST_LIMIT, TABLE_BUDGET, bfsTable, closedForm3, fsPar, stateCount } from '../js/core/solve.js';

const PAR_3 = { 1: 1, 2: 3, 3: 7, 4: 15, 5: 31, 6: 63, 7: 127, 8: 255, 9: 511, 10: 1023, 11: 2047, 12: 4095, 13: 8191 };
const PAR_4 = { 2: 3, 3: 5, 4: 9, 5: 13, 6: 17, 7: 25, 8: 33, 9: 41, 10: 49 };
// 线柱 rows print 3^n−1, typed by hand here and nowhere read back from solve.js.
const PAR_LINE = { 1: 2, 2: 8, 3: 26, 4: 80, 5: 242, 6: 728, 7: 2186, 8: 6560, 9: 19682, 10: 59048 };
const ROW_COUNT = 32;
const LINE_ROWS = 10;
const REVE = 49;

section('library: the table is the shape bake reported');
eq(LOTS_VERSION, 1, 'version 1: 线柱 rows were appended and carry their own `rule`, so no reader needs a new version to interpret them');
eq(LOTS.length, ROW_COUNT, `${rowCountHint()} rows shipped`);
eq(BAKE.rows, ROW_COUNT, 'and the bake banner agrees with the array it wrote');
eq(maxStates(), EXHAUST_LIMIT, 'the largest graph in the table is 3^13 = 1594323 positions');
eq(BAKE.capStates, EXHAUST_LIMIT, 'which is also the declared cap');
eq(BAKE.checks > 250, true, `bake ran ${BAKE.checks} build checks before it would write this file`);
ok(BAKE.ms > 0 && BAKE.ms < 60000, `bake finished in ${BAKE.ms} ms`);
eq(new Set(LOTS.map((r) => r.id)).size, LOTS.length, 'every row has a unique id');
eq(new Set(LOTS.map((r) => r.order)).size, LOTS.length, 'and a unique campaign position');
deepEq(LOTS.map((r) => r.order).sort((a, b) => a - b), LOTS.map((_, i) => i + 1), `campaign positions are 1..${ROW_COUNT} with no gaps`);

section('library: every row\'s par is arithmetic + measurement, both recorded');
for (const r of LOTS) {
  const line = r.rule === 'line';
  const expect = line ? PAR_LINE[r.n] : (r.pegs === 3 ? PAR_3[r.n] : PAR_4[r.n]);
  const witness = line ? '3^n-1' : (r.pegs === 3 ? '2^n-1' : 'Frame-Stewart');
  eq(r.par, expect, `${r.id}: printed par is the hand-typed ${witness} value ${expect}`);
  eq(r.states, stateCount(r.n, r.pegs), `${r.id}: states = pegs^n`);
  eq(r.closedForm, r.pegs === 3 && !line ? expect : null, `${r.id}: the three-peg closed form is printed where it applies`);
  eq(r.closedFormLine, line ? expect : null, `${r.id}: the 线柱 closed form is printed where it applies`);
  eq(r.frameStewart, r.pegs === 4 ? expect : null, `${r.id}: the FS value is printed where it applies`);
  eq(r.kind, 'canonical', `${r.id}: baked rows are canonical towers`);
  eq(r.start, startState(r.n, r.pegs), `${r.id}: starts as one tower on the first peg`);
  eq(r.goal, goalState(r.n, r.pegs), `${r.id}: finishes as one tower on the last peg`);
  eq(r.maxDist >= r.par, true, `${r.id}: the graph diameter is at least the canonical distance`);
  ok(r.ways >= 1, `${r.id}: at least one shortest route was counted (${r.ways})`);
  eq(Number.isSafeInteger(r.ways), true, `${r.id}: the route count is an exact integer, not a float estimate`);
  ok(rowExhaustive(r), `${r.id}: inside the exhaustive cap, so its par is a measurement`);
  eq(browserSweepable(r), r.states <= TABLE_BUDGET, `${r.id}: the sweep report agrees with the row's own graph size`);
  if (line) ok(browserSweepable(r), `${r.id}: a 线柱 row is only shippable while the browser can re-sweep it`);
}
{
  const three = LOTS.filter((r) => r.pegs === 3 && r.rule !== 'line');
  eq(three.length, 13, 'thirteen free three-peg rows');
  eq(three.every((r) => r.ways === 1), true, 'every three-peg row has exactly ONE shortest route — the classic uniqueness result, measured');
  const line = LOTS.filter((r) => r.rule === 'line');
  eq(line.length, LINE_ROWS, `the 线柱 band shipped ${LINE_ROWS} rows`);
  eq(line.every((r) => r.ways === 1), true, 'the adjacency restriction leaves the shortest route unique too, measured on its own graph');
  const four = LOTS.filter((r) => r.pegs === 4);
  eq(four.some((r) => r.ways > 1), true, 'four-peg rows have several, which is why the hint can only be one of them');
  eq(byId('lot-4p-10').par, REVE, 'the ten-disk, four-peg row prints 49');
  eq(byId('lot-4p-10').ways, LOTS.find((r) => r.id === 'lot-4p-10').ways, '…and its route count came from the table');
  eq(byId('lot-3p-13').states, 1594323, 'the deepest row is the 3^13 one');
  eq(byId('lot-line-8').par, 6560, 'the eight-disk 线柱 tower prints 3^8−1 = 6560');
  eq(byId('lot-4p-10').rule, 'free', 'a row written before the variant existed reads as the published game');
  eq(browserSweepable(byId('lot-4p-10')), false, '…and the browser will not sweep it on the player\'s clock');
  eq(browserSweepable(byId('lot-4p-8')), true, 'while 4^8 = 65536 is exactly the sweep budget');
}

section('library: nothing was published that could not be re-solved');
{
  // The dropped shapes: FS(11) = 65 and FS(12) = 81 are asserted in test/solve.test.mjs, but a
  // LOT row has to be re-solvable by this browser, and 4^11 = 41,943,040 positions is over the
  // cap. That rule, not a judgement call, is what removed them.
  eq(LOTS.some((r) => r.pegs === 4 && r.n >= 11), false, 'no four-peg row above n = 10');
  eq(LOTS.some((r) => r.pegs === 3 && r.rule !== 'line' && r.n >= 14), false, 'no free three-peg row above n = 13');
  eq(LOTS.some((r) => r.rule === 'line' && r.n >= 11), false, 'no 线柱 row above n = 10 either');
  eq(stateCount(11, 3), 177147, '3^11 is the next graph up, and it is over the browser sweep budget');
  eq(stateCount(10, 3), 59049, '3^10 is the last one under it — that is the variant ceiling, measured');
  eq(stateCount(11, 4) > EXHAUST_LIMIT, true, '4^11 really is beyond the cap that made them leave');
  eq(fsPar(11), 65, '…whose published FS value is still known, and still tested');
  eq(fsPar(12), 81, '…and so is n = 12');
  eq(LOTS.every((r) => r.states <= EXHAUST_LIMIT), true, 'every shipped row is inside the cap');
  const live = LOTS.filter((r) => r.states <= TABLE_BUDGET).length;
  eq(live, 27, '27 of the 32 rows are small enough for the browser to sweep itself (3^1..10, 4^2..8, 线柱 3^1..10)');
  eq(LOTS.filter((r) => r.pegs === 4 && r.n <= 8).length, 7, 'four-peg rows up to n=8');
  eq(LOTS.filter((r) => r.pegs === 3 && r.rule !== 'line' && r.n <= 10).length, 10, 'free three-peg rows up to n=10');
}

section('library: re-solve from disk (this is the spec\'s bake rule, as a runtime assertion)');
{
  const t0 = performance.now();
  const v = verifyAll();
  const ms = performance.now() - t0;
  eq(v.length, ROW_COUNT, 'every row re-solved');
  eq(v.filter((r) => !r.ok).length, 0, `no printed par disagrees with a fresh exhaustive BFS (${ms.toFixed(0)} ms)`);
  for (const r of v) {
    eq(r.measured, r.printed, `${r.id}: exhaustive re-sweep reproduces the printed par`);
    eq(r.runtime, r.printed, `${r.id}: the runtime metrics agree too`);
    eq(r.arithmetic, r.printed, `${r.id}: and so does the arithmetic`);
    eq(r.waysMeasured, r.waysPrinted, `${r.id}: and the number of shortest routes`);
  }
  const summary = verifySummary();
  deepEq([summary.rows, summary.failures], [ROW_COUNT, 0], 'verifySummary() agrees with verifyAll()');
}

section('library: the doors');
{
  const list = campaign();
  eq(list.length, ROW_COUNT, 'the campaign offers every row');
  eq(list[0].id, firstRow().id, 'and starts on the shallowest board');
  eq(list[0].par, 1, 'n=1 on three pegs: one move');
  eq(list[list.length - 1].id, 'lot-line-10', 'the campaign ends on the 59,048-move 线柱 tower');
  eq(list[list.length - 1].par, 59048, '…which is 3^10−1, and the last graph a browser can sweep by itself');
  const ranks = { shoal: 0, linked: 1, twined: 2, master: 3, line: 4 };
  let orderBad = 0;
  for (let i = 1; i < list.length; i++) {
    const a = `${ranks[list[i - 1].tier]}|${String(list[i - 1].par).padStart(6, '0')}`;
    const b = `${ranks[list[i].tier]}|${String(list[i].par).padStart(6, '0')}`;
    if (a > b) orderBad++;
  }
  eq(orderBad, 0, 'campaign order is band, then measured par — never by hand');
  eq(afterId('lot-3p-1').id, list[1].id, 'next after the first row is the second');
  eq(afterId('lot-3p-13').id, 'lot-line-1', 'the published game\'s deepest tower hands the campaign to 线柱');
  eq(afterId('lot-line-10'), null, 'the last row has no successor');
  eq(afterId('nope'), null, 'an unknown id has none either');
  eq(byId('no-such-lot'), null, 'byId says null, it does not invent a board');
  eq(byId('lot-3p-4').par, 15, 'a routed id resolves to the row the router printed');
}

section('library: the LOT line the spec asks for');
{
  const line = describe(LOTS.find((r) => r.id === 'lot-3p-4'));
  eq(line, 'n=4 pegs=3 par=15 routeCount=1 states=81 tier=shoal', 'the printed row is six labelled fields');
  ok(rowList().every((l) => /^n=\d+ pegs=[34] par=\d+ routeCount=\d+ states=\d+ tier=\w+$/.test(l)), 'every row prints in that format');
  eq(rowList().length, ROW_COUNT, `…${ROW_COUNT} times over`);
  eq(describe({ id: 'x', n: 1, pegs: 4, par: 1, ways: null, states: 4, tier: 'shoal' }), 'n=1 pegs=4 par=1 routeCount=- states=4 tier=shoal', 'an unmeasured route count prints as a dash, not as zero');
}

section('library: daily and random boards arrive through the same door as baked rows');
{
  const d = dailyBoard('2026-09-27');
  eq(d.id, 'daily-2026-09-27', 'the daily id names the date');
  eq(d.kind, 'scramble', 'it is a generated board, and says so');
  eq(dailyBand('2026-09-27'), d.tier, 'the band the library reports is the band the generator used');
  eq(describe(d).startsWith('n='), true, '…and it prints in the same six-field format as a baked row');
  eq(typeof d.par, 'number', 'its par is a measured number');
  ok(d.par < closedForm3(d.n) || d.pegs === 4, 'a scramble is shorter than the full tower of its shape');
  const r1 = randomLevel('abc', 'linked');
  const r2 = randomLevel('abc', 'linked');
  eq(r1.start, r2.start, 'a shared token is a shared board');
  eq(r1.id, r2.id, 'with a stable id for the record book');
  eq(randomLevel('abc', 'master').tier, 'master', 'the band chooses the shape pool');
  const g = createGame(d);
  let guard = 0;
  while (!g.done && guard++ < 400) moveTop(g, hint(g).from, hint(g).to);
  eq(g.moves, d.par, 'the daily board plays to its measured par through the library door as well');
  eq(isExact(g), d.pegs === 3, 'three-peg boards are exact at click time; four-peg ones say so when they are not');
}

section('library: the 线柱 door serves certified towers, never an unmeasured scramble');
{
  // make.js's generator refuses this band — "band line has no scramble-able shape" — because the
  // walk-length study behind every scramble band was measured on the free graph. The route must
  // neither throw nor quietly re-band the request, so a 线柱 token picks one of the baked rows.
  const a = randomLevel('gate', 'line');
  eq(a.tier, 'line', 'the band the hash asked for is the band the board is in');
  eq(a.rule, 'line', 'and the rule travels with the level');
  eq(a.kind, 'canonical', 'a certified full tower, not a shuffle');
  eq(byId(a.id).par, a.par, 'the board is a baked row, so every number on it was measured at build time');
  eq(a.par, PAR_LINE[a.n], '…which is the hand-typed 3^n−1 for its height');
  eq(a.metrics.kind, 'table', 'the browser sweeps a 线柱 graph itself — no O(n) recursion exists for it');
  eq(a.metrics.exact, true, 'so its remaining-moves read is exact, not an em dash');
  const b = randomLevel('gate', 'line');
  deepEq([a.id, a.start, a.goal], [b.id, b.start, b.goal], 'a shared token is one shared 线柱 board');
  const seen = new Set();
  for (let i = 0; i < 60; i++) seen.add(randomLevel(`spread${i}`, 'line').id);
  eq(seen.size, LINE_ROWS, 'and 60 tokens reach all ten certified towers, not just the shallowest');
  const small = byId('lot-line-3');
  const g = createGame(small);
  let guard = 0;
  while (!g.done && guard++ < 60) moveTop(g, hint(g).from, hint(g).to);
  eq(g.moves, small.par, 'a 线柱 board played through hint+moveTop lands exactly on its printed par');
  eq(g.refused, 0, '…and the rule never refused a step of the certified route');
  eq(isExact(g), true, '…and stays exact the whole way');
  // The calendar is untouched. This is why LINE_BAND is appended in BANDS rather than pushed into
  // TIERS: dailyLevel hashes a date into `hash % TIERS.length`, so a fifth entry there would
  // re-band every date that has already been played and publish a different puzzle for them.
  eq(['2026-09-27', '2026-09-28', '2026-09-29', '2026-12-01'].map((d) => dailyBand(d)).join(','),
    'twined,linked,shoal,shoal', 'the four hand-typed date bands are still what they were before the variant');
  let lineDaily = 0;
  for (let m = 1; m <= 12; m++) {
    for (let day = 1; day <= 28; day += 3) if (dailyBand(`2026-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`) === 'line') lineDaily++;
  }
  eq(lineDaily, 0, 'and no date in a scanned year lands on a band that has nothing to serve it');
}

section('library: band bookkeeping matches the rows');
{
  const b = bands();
  deepEq(b.map((x) => x.key), ['shoal', 'linked', 'twined', 'master', 'line'], 'five bands in campaign order');
  deepEq(b.map((x) => x.label), ['浅滩', '连阶', '缠盘', '绝顶', '线柱'], 'with the spec\'s names plus the variant\'s');
  deepEq(b.map((x) => x.rows), [8, 3, 3, 8, 10], '8 / 3 / 3 / 8 / 10 baked rows');
  eq(b.reduce((a, x) => a + x.rows, 0), ROW_COUNT, 'and they add up to the table');
  ok(b.filter((x) => x.key !== 'line').every((x) => x.scrambleable >= 1), 'every published band can also generate a board');
  eq(b.find((x) => x.key === 'line').scrambleable, 0, '线柱 ships certified towers only — its walk bands were never measured');
  deepEq(b.map((x) => x.scrambleParRange).filter(Boolean).length, 4, 'the four generating bands report a measured scramble range');
  const lineMeta = b.find((x) => x.key === 'line');
  deepEq(lineMeta.canonicalParRange, [2, 59048], 'and the variant band reports the range BFS measured');
  eq(lineMeta.shapes.length, LINE_ROWS, 'with one listed shape per shipped 线柱 row');
  const s = stats();
  eq(s.rows, ROW_COUNT, 'stats counts the rows');
  eq(s.maxStates, EXHAUST_LIMIT, 'and the deepest graph');
  eq(s.checks, BAKE.checks, 'and repeats the bake\'s own check count');
  ok(s.counterProof.includes('7') && s.counterProof.includes('3'), `the counter-proof travels with the table: "${s.counterProof}"`);
  deepEq(BAKE.walkStudy.map((w) => w.k), [20, 40, 80, 160, 400], 'the walk-length study is recorded, not remembered');
  ok(BAKE.walkStudy.every((w, i) => i === 0 || w.median >= BAKE.walkStudy[i - 1].median), 'and it is monotone: longer walks land farther away');
  ok(BAKE.acceptance > 0.2 && BAKE.acceptance <= 1, `the generator's acceptance rate is published (${BAKE.acceptance})`);
}

const c = run();
process.exit(c.fails ? 1 : 0);

function rowCountHint() {
  return ROW_COUNT;
}
