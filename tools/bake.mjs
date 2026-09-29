// npm run bake  ->  node tools/bake.mjs [--check]
//
// The build step is a measurement, not a formatting pass. For every tower shape the game can
// ship it:
//
//   1. exhaustively BFSes the *whole* position graph (pegs^n states, rooted at the finished
//      tower) and reads the true minimum number of moves off `dist[start]`;
//   2. compares that number with the arithmetic everyone quotes (2^n - 1 on three pegs,
//      Frame-Stewart on four, 3^n - 1 and (3^n - 1)/2 for the 线柱 variant) and with the
//      hand-typed anchor vectors below;
//   3. counts the distinct shortest routes on the BFS DAG (`ways`), so "this par is reachable"
//      is backed by a route, not by hope;
//   4. re-runs the rule-free BFS (strict = false) for n = 3 to show the size rule is load
//      bearing — without it the optimum is smaller, so the rule is not decoration;
//   5. samples the scramble generator so the difficulty bands carry measured par ranges
//      instead of adjectives.
//
// Any disagreement aborts with exit 1 and prints nothing to js/data/lots.js: a shipped LOT row
// whose par the browser cannot reproduce is worse than no row at all.
//
// Measured caps: 3^13 = 1,594,323 positions is the largest graph this repo solves (see
// js/core/solve.js EXHAUST_LIMIT). 4^11 = 41,943,040 is over it, which is why the published
// Frame-Stewart values for n = 11, 12 (65, 81) are asserted in the test suite but NOT shipped as
// LOT rows -- the spec's own "cannot reproduce the printed par, drop the row" rule removes them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { goalState, startState } from '../js/core/game.js';
import {
  EXHAUST_LIMIT, TABLE_BUDGET, bfsTable, closedForm3, closedFormLine, closedFormLineHalf,
  fitsExhaustive, fsPar, frameStewart,
  fsRoute, replayRoute, stateCount, dist3,
} from '../js/core/solve.js';
import { ALL_SHAPES, BANDS, canonicalLevel, scramble, shapesIn, canScramble } from '../js/core/make.js';
import { legalMoves, applyMove } from '../js/core/game.js';
import { rngFrom } from '../js/core/rng.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECK_ONLY = process.argv.includes('--check');

// ---- hand-typed anchors (never read back from the implementation) --------------------------
const ANCHOR_CLOSED_FORM = [1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383];
const ANCHOR_FRAME_STEWART = [1, 3, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81];
// 线柱 (three pegs in a row, neighbouring pegs only): corner→corner 3^n−1, corner→middle
// (3^n−1)/2, n = 1..13.
const ANCHOR_LINE_FULL = [2, 8, 26, 80, 242, 728, 2186, 6560, 19682, 59048, 177146, 531440, 1594322];
const ANCHOR_LINE_HALF = [1, 4, 13, 40, 121, 364, 1093, 3280, 9841, 29524, 88573, 265720, 797161];
const ANCHOR_STATE_SPACE = 1594323; // 3^13, the largest graph exhausted at boot

const failures = [];
const notes = [];
let checks = 0;
function check(cond, label, detail = '') {
  checks++;
  if (cond) return true;
  failures.push(`${label}${detail ? ` (${detail})` : ''}`);
  console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}
function ms(fn) {
  const t0 = performance.now();
  const out = fn();
  return { out, ms: performance.now() - t0 };
}

console.log('bake: 汉诺塔 level table');
console.log(`  caps: EXHAUST_LIMIT=${EXHAUST_LIMIT} TABLE_BUDGET=${TABLE_BUDGET} node=${process.version}`);

// ---- 0. the arithmetic anchors -------------------------------------------------------------
check(stateCount(13, 3) === ANCHOR_STATE_SPACE, '3^13 state space', `${stateCount(13, 3)}`);
check(EXHAUST_LIMIT === ANCHOR_STATE_SPACE, 'EXHAUST_LIMIT equals 3^13');
check(fitsExhaustive(13, 3) && !fitsExhaustive(14, 3), '13 disks fit exhaustively, 14 do not');
for (let n = 1; n <= 14; n++) {
  check(closedForm3(n) === ANCHOR_CLOSED_FORM[n - 1], `closed form 2^${n}-1`, `${closedForm3(n)}`);
}
const fs = frameStewart(12);
for (let n = 1; n <= 12; n++) {
  check(fs[n] === ANCHOR_FRAME_STEWART[n - 1], `Frame-Stewart F(${n})`, `${fs[n]}`);
  check(fsPar(n) === ANCHOR_FRAME_STEWART[n - 1], `fsPar(${n})`, `${fsPar(n)}`);
}
for (let n = 1; n <= 13; n++) {
  check(closedFormLine(n) === ANCHOR_LINE_FULL[n - 1], `线柱 closed form 3^${n}-1`, `${closedFormLine(n)}`);
  check(closedFormLineHalf(n) === ANCHOR_LINE_HALF[n - 1], `线柱 closed form (3^${n}-1)/2`, `${closedFormLineHalf(n)}`);
  check(closedFormLine(n) === 2 * closedFormLineHalf(n), `线柱 n=${n}: the two targets satisfy T = 2·S`,
    `${closedFormLine(n)} vs ${2 * closedFormLineHalf(n)}`);
}
check(!fitsExhaustive(11, 4), '4^11 is beyond the exhaustive cap', `${stateCount(11, 4)}`);

// The four-peg rows we DO ship must be reachable, not just counted: replay the constructive
// Frame-Stewart route under the real rule.
for (let n = 1; n <= 10; n++) {
  const route = fsRoute(n, 4);
  const end = ms(() => replayRoute(n, 4, route));
  check(end.out.end === goalState(n, 4), `Frame-Stewart route n=${n} replays to the goal`, JSON.stringify(end.out.end));
  check(end.out.states.length === route.length + 1, `Frame-Stewart route n=${n} passes through F(n)+1 states`);
  check(new Set(end.out.states).size === route.length + 1, `Frame-Stewart route n=${n} never revisits a position`);
  check(route.length === ANCHOR_FRAME_STEWART[n - 1], `Frame-Stewart route n=${n} has F(n) moves`, `${route.length}`);
}

// ---- 1./2./3. every shape: exhaustive BFS, arithmetic, cross-check -------------------------
const rows = [];
const bakeT0 = performance.now();
let maxStatesSeen = 0;
console.log('\n  n pegs par routeCount states tier');
for (const shape of ALL_SHAPES) {
  const { pegs, n, tier } = shape;
  const rule = shape.rule || 'free';
  const id = rule === 'line' ? `lot-line-${n}` : `lot-${pegs}p-${n}`;
  const start = startState(n, pegs);
  const goal = goalState(n, pegs);
  const size = stateCount(n, pegs);
  if (!fitsExhaustive(n, pegs)) {
    notes.push(`skipped ${pegs}p/${n}d: ${size} positions > ${EXHAUST_LIMIT}`);
    console.log(`  skip ${pegs}p n=${n} (${size} states exceeds cap)`);
    continue;
  }
  const run = ms(() => bfsTable(n, pegs, { ways: true, rule }));
  const t = run.out;
  const measured = t.dist[start];
  const ways = t.routeCount ? t.routeCount[start] : null;
  const arithmetic = rule === 'line' ? closedFormLine(n) : (pegs === 3 ? closedForm3(n) : fsPar(n));
  maxStatesSeen = Math.max(maxStatesSeen, size);

  check(t.complete, `${pegs}p n=${n} ${rule}: BFS visited every position`, `${t.reached}/${size}`);
  check(measured >= 0, `${pegs}p n=${n} ${rule}: start reachable from the goal`, `${measured}`);
  check(measured === arithmetic, `${pegs}p n=${n}: exhaustive par equals ${rule === 'line' ? '3^n-1' : (pegs === 3 ? '2^n-1' : 'Frame-Stewart')}`,
    `bfs=${measured} arithmetic=${arithmetic}`);
  check(t.maxDist >= measured, `${pegs}p n=${n}: the graph diameter covers the canonical par`,
    `maxDist=${t.maxDist} par=${measured}`);
  if (pegs === 3) {
    check(t.maxDist === measured, `${pegs}p n=${n}: on three pegs the canonical tower is farthest`,
      `maxDist=${t.maxDist} par=${measured}`);
  }
  if (pegs === 3 && rule === 'free') {
    check(dist3(start, n, pegs - 1) === measured, `${pegs}p n=${n}: the O(n) recursion agrees with BFS`,
      `${dist3(start, n, pegs - 1)}`);
  }
  if (rule === 'line') {
    // The variant has no recursion to lean on, so a 线柱 row is only shippable while the browser
    // itself can re-sweep the graph — that is what LINE_MAX_N = 10 is, and this is what keeps it.
    check(size <= TABLE_BUDGET, `线柱 n=${n}: ${size} positions is inside the browser sweep budget`,
      `budget=${TABLE_BUDGET}`);
    // The published optimum for the *other* target peg, measured on the same graph.
    const half = closedFormLineHalf(n);
    const tm = bfsTable(n, pegs, { rule, root: half });
    check(tm.complete, `线柱 n=${n}: the sweep rooted at the middle tower also covers the graph`, `${tm.reached}/${size}`);
    check(tm.dist[start] === ANCHOR_LINE_HALF[n - 1], `线柱 n=${n}: corner→middle BFS equals the typed anchor ${(3 ** n - 1) / 2}`,
      `bfs=${tm.dist[start]} anchor=${ANCHOR_LINE_HALF[n - 1]}`);
    check(measured !== dist3(start, n, pegs - 1), `线柱 n=${n}: the free recursion is not the variant's answer`,
      `bfs=${measured} dist3=${dist3(start, n, pegs - 1)}`);
  }
  if (ways !== null) {
    check(Number.isSafeInteger(ways), `${pegs}p n=${n}: route count is an exact integer`, `${ways}`);
    check(ways >= 1, `${pegs}p n=${n}: at least one shortest route exists`);
  }

  const level = canonicalLevel(pegs, n, id, rule);
  check(level.par === measured, `${pegs}p n=${n} ${rule}: make.js measures the same par as BFS`, `${level.par}`);
  check(level.metrics.remaining(level.start, 0) === measured, `${pegs}p n=${n} ${rule}: runtime metrics agree with BFS`);
  if (rule === 'line') {
    check(level.metrics.kind === 'table', `线柱 n=${n}: the row's distance comes from a swept table`, level.metrics.kind);
    check(level.closedForm === null && level.closedFormLine === measured, `线柱 n=${n}: the row prints its own witness column, not 2^n−1`);
  }

  rows.push({
    id,
    kind: 'canonical',
    tier,
    pegs,
    n,
    rule,
    start,
    goal,
    par: measured,
    states: size,
    closedForm: pegs === 3 && rule === 'free' ? closedForm3(n) : null,
    closedFormLine: rule === 'line' ? closedFormLine(n) : null,
    frameStewart: pegs === 4 && rule === 'free' ? fsPar(n) : null,
    ways,
    maxDist: t.maxDist,
    edges: t.edges,
    solve: { via: 'bfs-exhaustive', states: size, ms: Math.round(run.ms * 100) / 100 },
  });
  const label = rule === 'line' ? `3^${n}-1` : (pegs === 3 ? `2^${n}-1` : `F(${n})`);
  console.log(`  ${String(n).padStart(2)}  ${pegs}   ${String(measured).padStart(6)}  ${String(ways).padStart(6)}  ${String(size).padStart(8)}  ${tier}   ${label}=${arithmetic} bfs=${run.ms.toFixed(1)}ms`);
}

// campaign order: shallowest band first, then by measured par, so the door list is monotone.
const tierRank = new Map(BANDS.map((t, i) => [t.key, i]));
rows.sort((a, b) => tierRank.get(a.tier) - tierRank.get(b.tier) || a.par - b.par || a.n - b.n || a.pegs - b.pegs);
rows.forEach((r, i) => { r.order = i + 1; });

check(rows.length === ALL_SHAPES.length, 'every shape produced a row', `${rows.length}/${ALL_SHAPES.length}`);
check(rows.every((r) => r.par > 0), 'no row shipped with a zero par');
check(rows.some((r) => r.states === EXHAUST_LIMIT), 'the 3^13 row really shipped', '');
check(rows.filter((r) => r.rule === 'line').length === 10, 'the 线柱 band shipped its whole measured family', `${rows.filter((r) => r.rule === 'line').length}`);

// ---- 4. the counter-proof: drop the size rule and the optimum shrinks ----------------------
// Same graph, same start and goal, only the "no larger disk on a smaller one" test removed. The
// exhaustive sweep then finds a strictly shorter route, which is what makes that rule load
// bearing rather than cosmetic. Reported in README/DESIGN as 7 -> 3 for n = 3.
{
  const n = 3;
  const strict = bfsTable(n, 3, { strict: true });
  const loose = bfsTable(n, 3, { strict: false });
  const start = startState(n, 3);
  const sPar = strict.dist[start];
  const lPar = loose.dist[start];
  check(sPar === 7, 'n=3 strict optimum is 7', `${sPar}`);
  check(lPar < sPar, 'removing the size rule must shorten the optimum', `loose=${lPar}`);
  console.log(`\n  counter-proof n=3: strict par=${sPar}  rule-free par=${lPar}  (smaller => the rule is load bearing)`);
  notes.push(`counter-proof n=3: strict ${sPar} vs rule-free ${lPar}`);
}

// ---- 5. measured difficulty of the generator ------------------------------------------------
// Scrambles are random *legal* walks off the finished tower, so their measured par is far below
// 2^n-1 for the same shape; bake reports the acceptance rate and the observed par range rather
// than describing the boards as "hard".
// How far a random legal walk actually gets, per step budget. This is the measurement behind
// make.js `bandFor`: distance from the goal changes by exactly 1 per move, so a k-step walk can
// never land more than k away, and in practice it lands around 0.7*sqrt(k) away.
console.log('\n  walk study (3 pegs, 13 disks; 200 walks per step budget):');
const walkStudy = [];
{
  const pegs = 3;
  const n = 13;
  const goal = goalState(n, pegs);
  for (const k of [20, 40, 80, 160, 400]) {
    const pars = [];
    for (let t = 0; t < 200; t++) {
      const rng = rngFrom(`study|${k}|${t}`);
      let s = goal;
      for (let i = 0; i < k; i++) {
        const moves = legalMoves(s, n, pegs);
        const mv = rng.pick(moves);
        s = applyMove(s, mv.disk, mv.to, n, pegs);
      }
      pars.push(dist3(s, n, pegs - 1));
    }
    pars.sort((a, b) => a - b);
    const med = pars[100];
    walkStudy.push({ k, min: pars[0], median: med, p90: pars[180], max: pars[199] });
    console.log(`    k=${String(k).padStart(3)}  median par=${med}  p90=${pars[180]}  max=${pars[199]}  (0.7*sqrt(k)=${(0.7 * Math.sqrt(k)).toFixed(1)})`);
  }
  check(walkStudy[0].median <= 10, 'a 20-step walk stays near the goal', `${walkStudy[0].median}`);
  check(walkStudy[walkStudy.length - 1].median > walkStudy[0].median, 'longer walks land farther away');
}

const genStats = { tried: 0, accepted: 0, rejected: 0, relaxed: 0, parSum: 0, walkSum: 0, parTotal: 0 };
const tierBands = {};
let genMsMax = 0;
let genMsSum = 0;
let genMsN = 0;
for (const t of BANDS) {
  const pars = [];
  const pool = shapesIn(t.key).filter(canScramble);
  for (let i = 0; pool.length && i < 24; i++) {
    const shape = pool[i % pool.length];
    try {
      const g0 = performance.now();
      const sc = scramble(`bake|${t.key}|${i}`, shape.pegs, shape.n, {}, genStats);
      const spent = performance.now() - g0;
      genMsMax = Math.max(genMsMax, spent);
      genMsSum += spent;
      genMsN++;
      pars.push(sc.par);
    } catch (e) {
      notes.push(`band ${t.key} ${shape.pegs}p/${shape.n}d: ${e.message}`);
    }
  }
  tierBands[t.key] = {
    shapes: shapesIn(t.key).map((s) => `${s.pegs}柱${s.n}盘`),
    scrambleShapes: pool.map((s) => `${s.pegs}柱${s.n}盘`),
    canonicalPar: shapesIn(t.key).map((s) => (s.rule === 'line' ? closedFormLine(s.n) : (s.pegs === 3 ? closedForm3(s.n) : fsPar(s.n)))),
    samplePars: pars.length ? [Math.min(...pars), Math.max(...pars)] : null,
    sampleMean: pars.length ? Math.round((pars.reduce((a, b) => a + b, 0) / pars.length) * 100) / 100 : null,
  };
}
const acceptance = genStats.tried ? genStats.accepted / genStats.tried : 0;
const meanPar = genStats.accepted ? genStats.parTotal / genStats.accepted : 0;
const genMeanMs = genMsN ? genMsSum / genMsN : 0;
console.log(`  generator: ${genStats.tried} walks tried, ${genStats.accepted} accepted in band (${(acceptance * 100).toFixed(0)}%), ${genStats.relaxed} relaxed, mean accepted par ${meanPar.toFixed(1)}, mean walk length ${(genStats.walkSum / genStats.tried).toFixed(1)}`);
console.log(`  one board takes ${genMeanMs.toFixed(2)} ms on average, worst ${genMsMax.toFixed(2)} ms (${genMsN} boards)`);
notes.push(`scramble acceptance ${(acceptance * 100).toFixed(1)}% over ${genStats.tried} walks, ${genStats.relaxed} relaxed`);
notes.push(`generation mean ${genMeanMs.toFixed(2)} ms, worst ${genMsMax.toFixed(2)} ms per board`);

const tiersMeta = BANDS.map((t) => ({
  key: t.key,
  label: t.label,
  shapes: tierBands[t.key].shapes,
  scrambleShapes: tierBands[t.key].scrambleShapes,
  canonicalParRange: [Math.min(...tierBands[t.key].canonicalPar), Math.max(...tierBands[t.key].canonicalPar)],
  scrambleParRange: tierBands[t.key].samplePars,
  rows: rows.filter((r) => r.tier === t.key).length,
}));

const bake = {
  generatedBy: 'tools/bake.mjs',
  at: new Date().toISOString().slice(0, 19) + 'Z',
  node: process.version,
  rows: rows.length,
  shapes: ALL_SHAPES.length,
  maxStates: maxStatesSeen,
  capStates: EXHAUST_LIMIT,
  checks,
  ms: Math.round((performance.now() - bakeT0) * 100) / 100,
  acceptance: Math.round(acceptance * 1000) / 1000,
  meanScramblePar: Math.round(meanPar * 100) / 100,
  relaxedWalks: genStats.relaxed,
  genMeanMs: Math.round(genMeanMs * 1000) / 1000,
  genMaxMs: Math.round(genMsMax * 1000) / 1000,
  boardsSampled: genMsN,
  walkStudy,
  counterProof: notes.find((n) => n.startsWith('counter-proof')) || null,
  notes,
};

console.log(`\n  ${rows.length} rows, ${checks} build checks, ${maxStatesSeen} states is the largest graph exhausted, ${bake.ms} ms total`);

if (failures.length) {
  console.error(`\nbake FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

if (CHECK_ONLY) {
  console.log('\n--check: verified the table without writing js/data/lots.js');
  process.exit(0);
}

const banner = `// GENERATED by \`node tools/bake.mjs\` — do not edit by hand.
// Every \`par\` below is the value an exhaustive BFS over the whole pegs^n position graph
// reported for that board, cross-checked in the same run against 2^n-1 (三柱), Frame-Stewart
// (四柱) and 3^n-1 / (3^n-1)/2 (线柱, rows carrying \`"rule": "line"\`).
// Row order = campaign order (band, then measured par). Baked ${bake.at} on node ${bake.node}.
// LOTS_VERSION stays 1: the 线柱 rows were appended, not renumbered, and each carries its own
// \`"rule"\`, so nothing a reader of the previous table relied on changed meaning.`;

const body = `${banner}

// Stays 1 with the 线柱 rows appended: each new row carries its own \`rule\`, the ids and order of
// the free rows did not move, and a reader that ignores both fields still plays the published game.
export const LOTS_VERSION = 1;

export const BAKE = ${JSON.stringify(bake, null, 2)};

export const TIERS_META = ${JSON.stringify(tiersMeta, null, 2)};

export const LOTS = ${JSON.stringify(rows, null, 2)};

export function byId(id) {
  return LOTS.find((r) => r.id === id) || null;
}

export default LOTS;
`;

const out = join(ROOT, 'js', 'data', 'lots.js');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, body);
console.log(`wrote ${out} (${body.length} bytes)`);
