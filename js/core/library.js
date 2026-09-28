// The door between the baked table (js/data/lots.js, produced by `node tools/bake.mjs`) and the
// game. Rows on disk carry no closures — a metrics object holds functions, and functions do not
// survive JSON — so this file re-derives them with the SAME machinery bake used, from the row's
// own (pegs, n, goal, start). That is what makes "the number on screen is the number that was
// measured" true at runtime rather than a comment: `verifyAll()` below re-solves every row from
// scratch and test/library.test.mjs refuses a table where a printed par and a re-measured par
// disagree.
//
// Metrics are built lazily and cached per (n, pegs, goal, start) inside solve.js, so importing
// this module costs nothing: opening `#/lot/lot-4p-10` is the only thing that sweeps 1,048,576
// positions, and it happens when that row is actually requested.

import { goalState, startState } from './game.js';
import { EXHAUST_LIMIT, TABLE_BUDGET, closedForm3, fsPar, metricsFor, stateCount, fitsExhaustive, bfsTable } from './solve.js';
import { TIERS, canonicalLevel, dailyLevel, makeLevel, shapesIn, tierByKey, canScramble } from './make.js';
import { hashSeed } from './rng.js';
import LOTS, { BAKE, LOTS_VERSION, TIERS_META } from '../data/lots.js';

export { LOTS, BAKE, LOTS_VERSION, TIERS_META };

const attached = new Map();

// The spec's LOT row, printed the same way by bake, the tests and the in-game index:
// n, pegs, par, routeCount, states, tier.
export function describe(row) {
  return `n=${row.n} pegs=${row.pegs} par=${row.par} routeCount=${row.ways === null ? '-' : row.ways} states=${row.states} tier=${row.tier}`;
}

export function rowList() {
  return LOTS.map((r) => describe(r));
}

export function rowCount() {
  return LOTS.length;
}

export function maxStates() {
  return LOTS.reduce((a, r) => Math.max(a, r.states), 0);
}

// The single row the campaign shows first, and the fallback door for an unknown id.
export function firstRow() {
  return LOTS.reduce((a, r) => (a && a.par <= r.par ? a : r), null);
}

// A row on disk -> a level the game can play. Only `metrics` is added; nothing numeric changes.
export function levelFor(row) {
  if (!row) return null;
  const key = `${row.id || row.kind}|${row.pegs}|${row.n}|${row.start}`;
  const hit = attached.get(key);
  if (hit) return hit;
  const goal = row.goal === undefined ? goalState(row.n, row.pegs) : row.goal;
  const level = {
    ...row,
    goal,
    metrics: metricsFor(row.n, row.pegs, goal, row.start),
  };
  attached.set(key, level);
  return level;
}

export function byId(id) {
  const row = LOTS.find((r) => r.id === String(id));
  return row ? levelFor(row) : null;
}

// Campaign order is baked in (band, then measured par); `index` is 0-based.
export function campaign() {
  return LOTS.slice().sort((a, b) => a.order - b.order).map(levelFor);
}

export function afterId(id) {
  const list = LOTS.slice().sort((a, b) => a.order - b.order);
  const i = list.findIndex((r) => r.id === String(id));
  if (i === -1 || i + 1 >= list.length) return null;
  return levelFor(list[i + 1]);
}

export function bands() {
  return TIERS.map((t) => {
    const meta = TIERS_META.find((m) => m.key === t.key) || {};
    return {
      key: t.key,
      label: t.label,
      shapes: meta.shapes || shapesIn(t.key).map((s) => `${s.pegs}柱${s.n}盘`),
      scrambleShapes: meta.scrambleShapes || [],
      canonicalParRange: meta.canonicalParRange || null,
      scrambleParRange: meta.scrambleParRange || null,
      rows: LOTS.filter((r) => r.tier === t.key).length,
      scrambleable: shapesIn(t.key).filter(canScramble).length,
    };
  });
}

// The random door: same token, same board, on any device — hashSeed is specified in test/rng.test.mjs.
export function randomLevel(seed, tierKey = 'shoal') {
  const level = makeLevel(String(seed), tierByKey(tierKey).key);
  return levelFor({ ...level, id: level.id || `random-${tierKey}-${hashSeed(String(seed))}` });
}

export function dailyBoard(dateKey) {
  const level = dailyLevel(dateKey);
  return levelFor({ ...level, id: level.id });
}

// Which band today's date lands in, derived the same way make.dailyLevel does (no lookup table).
export function dailyBand(dateKey) {
  const h = hashSeed(`daily|${dateKey}`);
  return TIERS[h % TIERS.length].key;
}

// Everything the info strip and the tests want to know about the table itself.
export function stats() {
  return {
    version: LOTS_VERSION,
    rows: LOTS.length,
    bakedAt: BAKE.at,
    checks: BAKE.checks,
    maxStates: maxStates(),
    capStates: EXHAUST_LIMIT,
    tableBudget: TABLE_BUDGET,
    acceptance: BAKE.acceptance,
    meanScramblePar: BAKE.meanScramblePar,
    counterProof: BAKE.counterProof,
    bands: bands(),
  };
}

// Re-solve every printed par with an exhaustive sweep of that row's own graph. This is the
// spec's "bake must re-solve and reproduce par" rule, expressed as a runtime assertion the test
// suite can call; it costs ~1.5 s because it re-runs the 3^13 and 4^10 graphs.
export function verifyAll({ progress = null } = {}) {
  const out = [];
  for (const row of LOTS) {
    const size = stateCount(row.n, row.pegs);
    let measured = null;
    let ways = null;
    if (size <= EXHAUST_LIMIT) {
      const t = bfsTable(row.n, row.pegs, { ways: true, root: row.goal });
      measured = t.dist[startState(row.n, row.pegs)];
      ways = t.routeCount[startState(row.n, row.pegs)];
    }
    const runtime = levelFor(row).metrics.remaining(row.start, 0);
    out.push({
      id: row.id,
      printed: row.par,
      measured,
      runtime,
      waysPrinted: row.ways,
      waysMeasured: ways,
      arithmetic: row.pegs === 3 ? closedForm3(row.n) : fsPar(row.n),
      ok: row.par === measured && measured === runtime && row.par === (row.pegs === 3 ? closedForm3(row.n) : fsPar(row.n)),
    });
    if (progress) progress(out.length, LOTS.length, row.id);
  }
  return out;
}

export function verifySummary() {
  const v = verifyAll();
  const bad = v.filter((r) => !r.ok);
  return { rows: v.length, failures: bad.length, bad: bad.map((r) => r.id) };
}

// Is a row's par something the browser can re-derive by itself? True while the graph fits the
// exhaustive cap; four-peg rows above 4^8 still fit 3^13-style sweeps, and nothing ships beyond
// EXHAUST_LIMIT at all (see the 4^11 / 4^12 note in make.js).
export function rowExhaustive(row) {
  return fitsExhaustive(row.n, row.pegs);
}

export function browserSweepable(row) {
  return stateCount(row.n, row.pegs) <= TABLE_BUDGET;
}

export default { LOTS, BAKE, byId, campaign, dailyBoard, randomLevel, describe, rowList, stats, verifyAll };
