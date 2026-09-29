// The generator: which shape a board has, and (for the daily and the random doors) where its
// disks start. Difficulty is never an opinion here — a level's `par` is read out of the same
// instruments js/core/solve.js provides, so a generated board and a baked board are the same
// kind of object and get re-solved by the same code.
//
// Two kinds of level:
//
//   * canonical — the textbook tower: all n disks on the first peg, goal the last peg. Its
//     par is 2^n − 1 on three pegs and FS(n) on four, which is why every row carries both the
//     arithmetic (`closedForm` / `frameStewart`) and the measured `par`: tools/bake.mjs prints
//     the pair and refuses a row where the exhaustive sweep and the arithmetic disagree.
//   * scramble  — a *legal* shuffle only: k random legal moves taken away from the finished
//     tower, so the position lives inside the same graph and is solvable by construction. The
//     par printed for such a board is its measured distance, NOT the canonical 2^n − 1: a
//     board three moves from the goal has a proven minimum of 3, and stamping 8191 under the
//     heading "已证下界" would be a lie about a number nobody proved. This is a deliberate
//     deviation from the spec's "par 仍按闭式印" and it is written up in DESIGN.md §5.
//
// Bands are named after the tower shape (the spec's n ranges); their par ranges are measured
// from the rows that actually shipped and baked into js/data/lots.js as TIERS_META.

import { goalState, legalMoves, ruleSupported, startState, applyMove, MAX_DISKS } from './game.js';
import { EXHAUST_LIMIT, TABLE_BUDGET, closedForm3, closedFormLine, fsPar, metricsFor, stateCount } from './solve.js';
import { hashSeed, rngFrom } from './rng.js';

export const TIERS = [
  { key: 'shoal', label: '浅滩' },
  { key: 'linked', label: '连阶' },
  { key: 'twined', label: '缠盘' },
  { key: 'master', label: '绝顶' },
];

// The 线柱 band is appended, never spliced in: `dailyLevel` maps a date to a band with
// `hash % TIERS.length`, so putting a fifth band inside TIERS would silently re-band every
// date that has already been played. The variant therefore lives in BANDS (everything that
// lists bands) while TIERS stays the rotation the calendar hashes into.
export const LINE_BAND = { key: 'line', label: '线柱' };
export const BANDS = [...TIERS, LINE_BAND];

// The deepest 线柱 tower this repo can ship. `metricsFor` answers exactly for a 线柱 board only
// while the browser can sweep the whole graph itself (3^n ≤ TABLE_BUDGET), because `dist3` — the
// O(n) recursion that carries three-peg boards up to 13 disks — assumes a disk may hop to ANY
// peg. 3^10 = 59,049 is inside that budget, 3^11 = 177,147 is not: the ceiling is measured off
// the sweep budget, not chosen for difficulty.
export const LINE_MAX_N = 10;

export const LINE_SHAPES = [];
for (let n = 1; n <= LINE_MAX_N; n++) LINE_SHAPES.push({ pegs: 3, n, tier: LINE_BAND.key, rule: 'line' });

// Tier membership is by tower shape, exactly as the spec lays it out.
export function tierOf(pegs, n, rule = 'free') {
  if (rule === 'line') return pegs === 3 && n <= LINE_MAX_N ? LINE_BAND.key : null;
  if (pegs === 3) {
    if (n <= 4) return 'shoal';
    if (n <= 7) return 'linked';
    if (n <= 10) return 'twined';
    if (n <= MAX_DISKS) return 'master';
    return null;
  }
  if (pegs === 4) {
    if (n <= 5) return 'shoal';
    // 11/12 are dropped on purpose: FS is published there, but 4^11 = 41,943,040 positions is
    // over EXHAUST_LIMIT, so bake could not re-solve the par it would print. The spec's own
    // rule — "复现不出印着的 par 就构建失败" — removes them.
    if (n >= 6 && n <= 10) return 'master';
    return null;
  }
  return null;
}

export const SHAPES = [];
for (let pegs = 3; pegs <= 4; pegs++) {
  for (let n = 1; n <= MAX_DISKS; n++) {
    const tier = tierOf(pegs, n);
    if (!tier) continue;
    if (pegs === 4 && n === 1) continue; // one disk on four pegs is the same toy as on three
    SHAPES.push({ pegs, n, tier, rule: 'free' });
  }
}

// Everything bake is asked to produce a row for: the published game's shapes plus the variant's.
export const ALL_SHAPES = [...SHAPES, ...LINE_SHAPES];

export function shapesIn(tierKey) {
  return ALL_SHAPES.filter((s) => s.tier === tierKey);
}

export function tierByKey(key) {
  const hit = BANDS.find((t) => t.key === key);
  return hit || TIERS[0];
}

// The one door to "how many moves does this position need?", so a generated board and a baked
// board can never be measured with two different yardsticks. `rule` travels with it: a 线柱 board
// is measured on the adjacency graph, never on the free one.
export function parOf(state, pegs, n, goal = goalState(n, pegs), rule = 'free') {
  const m = metricsFor(n, pegs, goal, state, rule);
  return m.remaining(state, 0);
}

// The canonical tower for a shape, with its par from the distance machinery and the arithmetic
// alongside it: the two fields the spec asks every LOT row to print.
export function canonicalLevel(pegs, n, id = null, rule = 'free') {
  const start = startState(n, pegs);
  const goal = goalState(n, pegs);
  const line = rule === 'line';
  if (!ruleSupported(pegs, rule)) throw new Error(`canonicalLevel(${pegs}, ${n}, ${rule}): unsupported rule`);
  return {
    kind: 'canonical',
    id,
    pegs,
    n,
    rule,
    tier: tierOf(pegs, n),
    start,
    goal,
    par: parOf(start, pegs, n, goal, rule),
    states: stateCount(n, pegs),
    closedForm: pegs === 3 && !line ? closedForm3(n) : null,
    closedFormLine: line ? closedFormLine(n) : null,
    frameStewart: pegs === 4 && !line ? fsPar(n) : null,
    metrics: metricsFor(n, pegs, goal, start, rule),
  };
}

export function canScramble(shape) {
  // 线柱 boards ship as certified full towers only. The walk-length/par bands in `bandFor` are
  // measured from random walks on the FREE graph (tools/bake.mjs prints that study); a random walk
  // on the adjacency graph lands at a different distance, so reusing those constants would publish
  // a difficulty promise nobody measured. Refusing is the honest option until the study exists.
  if (shape.rule === 'line') return false;
  // One- and two-disk towers cannot hold a puzzle: the longest route there is 3 moves, so every
  // walk lands outside any sensible band. Such shapes are still shipped as canonical LOT rows.
  if (shape.n < 3) return false;
  // A scrambled start has no certified FS route to lean on, so a four-peg board may only be
  // shuffled while its whole graph is small enough for the browser to sweep.
  if (shape.pegs === 3) return stateCount(shape.n, 3) <= EXHAUST_LIMIT;
  return stateCount(shape.n, 4) <= TABLE_BUDGET;
}

// How far a random legal walk can plausibly land, per shape. Each step changes the distance to
// the goal by exactly 1, so a walk of k steps can never end up more than k away — the band and
// the walk length have to be chosen together. Measured here (1,000 walks per shape, see
// DESIGN.md §5): the distance after k steps sits around 0.7*sqrt(k), so the walk lengths below
// are (target / 0.7)^2, and the band stays inside what the shape can even express.
export function bandFor(pegs, n) {
  const ceiling = pegs === 3 ? closedForm3(n) : fsPar(n);
  const parMax = Math.max(4, Math.min(60, Math.ceil(ceiling * 0.6)));
  const parMin = Math.max(2, Math.floor(parMax / 4));
  const kMax = Math.min(400, Math.ceil((parMax / 0.7) ** 2));
  const kMin = Math.max(4, Math.min(kMax - 4, Math.round((parMin / 0.7) ** 2) - 8));
  return { kMin, kMax, parMin, parMax, tries: 60 };
}

// A legal shuffle: `k` random legal moves away from the finished tower, taken through the same
// `legalMoves` the player is judged by, so "this is solvable" is a property of how the board
// was made rather than a claim about the walk length. The acceptance rule is measured and
// printed by tools/bake.mjs: a walk that doubles back on itself lands close to the goal, and
// those boards are rejected rather than published with a par of 2. If every attempt lands
// outside the band the walk closest to it wins and says so (`relaxed: true`) — the par is still
// the measured distance, so a relaxed board is honest, just shallower than promised.
export function scramble(seed, pegs, n, opts = {}, stats) {
  const { kMin, kMax, parMin, parMax, tries } = { ...bandFor(pegs, n), ...opts };
  const goal = goalState(n, pegs);
  const rng = rngFrom(seed);
  const rejects = [];
  let best = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const k = rng.range(kMin, kMax);
    let s = goal;
    for (let i = 0; i < k; i++) {
      const moves = legalMoves(s, n, pegs);
      const mv = rng.pick(moves);
      s = applyMove(s, mv.disk, mv.to, n, pegs);
    }
    const par = parOf(s, pegs, n, goal);
    if (stats) {
      stats.tried = (stats.tried || 0) + 1;
      stats.parSum = (stats.parSum || 0) + (par === null ? 0 : par);
      stats.walkSum = (stats.walkSum || 0) + k;
    }
    const scored = par === null ? Infinity : Math.max(parMin - par, par - parMax, 0);
    if (best === null || scored < best.scored) best = { state: s, par, k, attempt, scored };
    if (par !== null && par >= parMin && par <= parMax) {
      if (stats) {
        stats.accepted = (stats.accepted || 0) + 1;
        stats.parTotal = (stats.parTotal || 0) + par;
      }
      return { state: s, par, k, attempt, band: [parMin, parMax], relaxed: false };
    }
    if (stats) stats.rejected = (stats.rejected || 0) + 1;
    rejects.push(par);
  }
  if (best && best.par !== null) {
    if (stats) stats.relaxed = (stats.relaxed || 0) + 1;
    return { ...best, band: [parMin, parMax], relaxed: true };
  }
  throw new Error(`scramble(${pegs} pegs, ${n} disks): ${tries} walks all landed outside par ${parMin}-${parMax} (e.g. ${rejects.slice(0, 6)})`);
}

// One deterministic random/daily board. `tierKey` picks the shape pool; the seed picks the
// shape, the walk length and the walk itself, so the same token is the same board everywhere.
export function makeLevel(seed, tierKey = 'shoal', stats) {
  const pool = shapesIn(tierKey).filter(canScramble);
  if (!pool.length) throw new Error(`band ${tierKey} has no scramble-able shape`);
  const rng = rngFrom(`${tierKey}|${seed}`);
  const shape = rng.pick(pool);
  const sc = scramble(`${tierKey}|${seed}`, shape.pegs, shape.n, {}, stats);
  const goal = goalState(shape.n, shape.pegs);
  return {
    kind: 'scramble',
    id: null,
    pegs: shape.pegs,
    n: shape.n,
    tier: tierKey,
    start: sc.state,
    goal,
    par: sc.par,
    states: stateCount(shape.n, shape.pegs),
    walk: sc.k,
    attempts: sc.attempt,
    band: sc.band,
    relaxed: sc.relaxed,
    closedForm: shape.pegs === 3 ? closedForm3(shape.n) : null,
    frameStewart: shape.pegs === 4 ? fsPar(shape.n) : null,
    metrics: metricsFor(shape.n, shape.pegs, goal, sc.state),
  };
}

// The daily board is `makeLevel` with the calendar date as its only input — that is the whole
// trick behind "everyone gets the same puzzle": no server, no table of daily seeds, one string
// run through the same FNV-1a hash every shared link uses.
export function dailyLevel(dateKey) {
  const h = hashSeed(`daily|${dateKey}`);
  const tier = TIERS[h % TIERS.length];
  const level = makeLevel(`daily|${dateKey}`, tier.key);
  return { ...level, id: `daily-${dateKey}` };
}

// What bake prints about the space, so the docs quote a run instead of a feeling.
export function census() {
  const byTier = BANDS.map((t) => {
    const shapes = shapesIn(t.key);
    return {
      key: t.key,
      label: t.label,
      shapes: shapes.map((s) => `${s.pegs}柱${s.n}盘`),
      canonicalPars: shapes.map((s) => canonicalLevel(s.pegs, s.n, null, s.rule).par),
      scrambleable: shapes.filter(canScramble).length,
    };
  });
  return { limit: EXHAUST_LIMIT, tableBudget: TABLE_BUDGET, tiers: byTier };
}
