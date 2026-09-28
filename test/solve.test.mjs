// The measurement suite. Every literal below was typed by hand from the spec's anchor list (or
// from a probe run made before this repo existed); none of them is read back out of
// js/core/solve.js. A green run here therefore means the shipped code agrees with an outside
// statement about the world, not with itself.

import { ok, eq, deepEq, throws, notThrows, run, section } from '../tools/harness.mjs';
import { goalState, startState, pegOf, decode, legalMoves, applyMove, canMove } from '../js/core/game.js';
import {
  EXHAUST_LIMIT, TABLE_BUDGET, FS_PUBLISHED_MAX, bfsTable, closedForm3, dist3, fitsExhaustive,
  frameStewart, fsPar, fsRoute, metricsFor, next3Move, replayRoute, routeCount, stateCount, table,
} from '../js/core/solve.js';

// ---- hand-typed anchors ---------------------------------------------------------------------
const BFS_THREE_TO_SEVEN = [1, 3, 7, 15, 31, 63, 127];                 // real BFS optimum, n=1..7
const CLOSED_FORM_ONE_TO_FOURTEEN = [1, 3, 7, 15, 31, 63, 127, 255, 511, 1023, 2047, 4095, 8191, 16383];
const FRAME_STEWART_ONE_TO_TWELVE = [1, 3, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81];
const REVE_TEN = 49;                                                    // the classic ten-disk answer
const LARGEST_EXHAUSTED_GRAPH = 1594323;                                // 3^13, the boot cap
const POSITIONS_UNDER_TEST = 3279;                                      // Σ 3^n for n=1..7

section('solve: the caps the rest of the repo reasons about');
eq(EXHAUST_LIMIT, LARGEST_EXHAUSTED_GRAPH, 'EXHAUST_LIMIT is 3^13 = 1594323');
eq(TABLE_BUDGET, 65536, 'the browser sweeps up to 65536 positions (4^8)');
eq(stateCount(13, 3), LARGEST_EXHAUSTED_GRAPH, '3^13 positions');
eq(stateCount(14, 3), 4782969, '3^14 positions, one third over the cap');
eq(stateCount(10, 4), 1048576, '4^10 positions fits under the cap');
eq(stateCount(11, 4), 4194304, '4^11 positions does not');
ok(fitsExhaustive(13, 3), '3^13 fits the exhaustive promise');
ok(!fitsExhaustive(14, 3), '3^14 does not');
ok(fitsExhaustive(10, 4), '4^10 fits');
ok(!fitsExhaustive(11, 4), '4^11 does not — which is why no 4^11 LOT row ships');
throws(() => bfsTable(14, 3), 'bfsTable refuses to start a graph it cannot finish');
throws(() => bfsTable(11, 4), 'bfsTable refuses 4^11');
throws(() => bfsTable(0, 3), 'bfsTable rejects n = 0');
throws(() => bfsTable(3, 5), 'bfsTable rejects five pegs (Frame-Stewart is unproven there)');

section('solve: 2^n − 1, n = 1..14');
for (let n = 1; n <= 14; n++) {
  eq(closedForm3(n), CLOSED_FORM_ONE_TO_FOURTEEN[n - 1], `closedForm3(${n}) = ${CLOSED_FORM_ONE_TO_FOURTEEN[n - 1]}`);
}

section('solve: exhaustive BFS reproduces the closed form, n = 1..7');
for (let n = 1; n <= 7; n++) {
  const t = bfsTable(n, 3, { ways: true });
  const start = startState(n, 3);
  eq(t.dist[start], BFS_THREE_TO_SEVEN[n - 1], `BFS optimum for ${n} disks on 3 pegs`);
  ok(t.complete, `BFS visited all ${t.size} positions for n = ${n}`);
  eq(t.reached, stateCount(n, 3), `queue drained exactly the state space, n = ${n}`);
  eq(t.routeCount[start], 1, `n = ${n}: exactly one shortest route exists on three pegs`);
  eq(t.maxDist, BFS_THREE_TO_SEVEN[n - 1], `n = ${n}: the full tower is a farthest position`);
  eq(t.dist[goalState(n, 3)], 0, `n = ${n}: the finished tower is at distance 0`);
}
eq(routeCount(7, 3), 1, 'routeCount(7,3) — the unique optimal route, read through the cache');
throws(() => table(13, 4), 'the cached table also respects the cap');

section('solve: three pegs, every position, two instruments');
// dist3 is the O(n) recursion the UI uses for boards too big to sweep. It is checked here
// against the exhaustive BFS for EVERY position of every graph up to n = 7 — 3279 positions.
{
  let checked = 0;
  let bad = 0;
  let hintBad = 0;
  let firstBad = null;
  for (let n = 1; n <= 7; n++) {
    const t = table(n, 3);
    const goalPeg = 2;
    for (let s = 0; s < t.size; s++) {
      checked++;
      if (t.dist[s] !== dist3(s, n, goalPeg)) {
        bad++;
        if (!firstBad) firstBad = { n, s, bfs: t.dist[s], rec: dist3(s, n, goalPeg) };
        continue;
      }
      const mv = next3Move(s, n, goalPeg);
      if (t.dist[s] === 0) {
        if (mv !== null) hintBad++;
        continue;
      }
      // The hint must be legal and must land exactly one step closer, or it is not a hint.
      if (!mv || !canMove(s, mv.disk, mv.to, n, 3) || t.dist[applyMove(s, mv.disk, mv.to, n, 3)] !== t.dist[s] - 1) hintBad++;
    }
  }
  eq(checked, POSITIONS_UNDER_TEST, 'positions compared against the exhaustive sweep');
  eq(bad, 0, `dist3 disagrees with BFS nowhere; first miss ${JSON.stringify(firstBad)}`);
  eq(hintBad, 0, 'next3Move is always legal and always one step closer (or null at the goal)');
}

section('solve: Frame-Stewart, n = 1..12 (published values)');
deepEq(frameStewart(12).slice(1), FRAME_STEWART_ONE_TO_TWELVE, 'the recursion reproduces the published range');
for (let n = 1; n <= 12; n++) {
  eq(fsPar(n), FRAME_STEWART_ONE_TO_TWELVE[n - 1], `fsPar(${n}) = ${FRAME_STEWART_ONE_TO_TWELVE[n - 1]}`);
}
eq(fsPar(10), REVE_TEN, "the Reve puzzle: ten disks on four pegs is 49, exhaustively confirmed below");
throws(() => frameStewart(13), 'no opinion beyond the published range');
eq(FS_PUBLISHED_MAX, 12, 'the published range ends at 12');

section('solve: four pegs, BFS *proves* Frame-Stewart while the graph still fits');
for (let n = 1; n <= 7; n++) {
  const t = bfsTable(n, 4);
  eq(t.dist[startState(n, 4)], FRAME_STEWART_ONE_TO_TWELVE[n - 1], `exhaustive BFS n=${n} on 4 pegs = F(${n})`);
  ok(t.complete, `4^${n} positions all reached`);
}
for (const n of [8, 9, 10]) {
  const t = bfsTable(n, 4);
  eq(t.dist[startState(n, 4)], FRAME_STEWART_ONE_TO_TWELVE[n - 1], `exhaustive BFS n=${n} on 4 pegs = F(${n}) (${t.size} positions)`);
}
eq(bfsTable(10, 4).dist[startState(10, 4)], REVE_TEN, 'n=10 on four pegs: 1,048,576 positions, minimum 49');
ok(bfsTable(10, 4, { ways: true }).routeCount[startState(10, 4)] > 1, 'the ten-disk Reve puzzle has many shortest routes (unlike three pegs)');

section('solve: certified routes really play out under the real rule');
for (let n = 1; n <= 10; n++) {
  const route = fsRoute(n, 4);
  eq(route.length, FRAME_STEWART_ONE_TO_TWELVE[n - 1], `fsRoute(${n}) is F(${n}) moves long`);
  const rep = notThrows(() => replayRoute(n, 4, route), `fsRoute(${n}) replays legally`);
  if (rep) {
    const r = replayRoute(n, 4, route);
    eq(r.end, goalState(n, 4), `fsRoute(${n}) ends at the finished tower`);
    eq(new Set(r.states).size, route.length + 1, `fsRoute(${n}) never revisits a position`);
  }
}
throws(() => replayRoute(3, 4, [{ disk: 2, from: 0, to: 3 }]), 'a route that buries a disk is rejected, not played');
throws(() => fsRoute(13, 4), 'no route is invented past the published range');

section('solve: the counter-proof — the size rule is load bearing');
// Same start, same goal, same move mechanics; only "a larger disk may not rest on a smaller one"
// is switched off. The optimum DROPS, which is what makes that rule part of the problem rather
// than a UI flourish. n = 3: 7 moves with the rule, 3 without (each disk hops once).
{
  const n = 3;
  const start = startState(n, 3);
  const strict = bfsTable(n, 3, { strict: true });
  const loose = bfsTable(n, 3, { strict: false });
  eq(strict.dist[start], 7, 'n=3 with the rule: 7');
  eq(loose.dist[start], 3, 'n=3 with the rule removed: 3');
  ok(loose.dist[start] < strict.dist[start], 'removing the rule strictly shortens the optimum');
  const n4 = bfsTable(4, 3, { strict: false });
  ok(n4.dist[startState(4, 3)] < 15, 'the same effect shows at n=4');
  eq(bfsTable(4, 3, { strict: true }).dist[startState(4, 3)], 15, 'n=4 with the rule: 15');
  // With the rule off, every disk only has to travel once.
  eq(n4.dist[startState(4, 3)], 4, 'rule-free n=4: one move per disk');
}

section('solve: metrics policy — what a board is allowed to claim on screen');
{
  const small = metricsFor(6, 3);
  eq(small.kind, 'table', '3^6 = 729 positions are swept in the browser');
  eq(small.remaining(startState(6, 3), 0), 63, 'swept distance for n=6');
  eq(small.next(startState(6, 3), 0).disk, 0, 'the hint on a swept board names the smallest disk first');
  const mid = metricsFor(13, 3);
  eq(mid.kind, 'dist3', '3^13 is answered by the recursion, no search');
  eq(mid.remaining(startState(13, 3), 0), 8191, 'recursive distance for n=13');
  eq(mid.exact, true, 'the recursion is exact, so the UI may print 剩余');
  const big4 = metricsFor(10, 4);
  eq(big4.kind, 'route', '4^10 = 1,048,576 positions are not swept on the player\'s clock');
  eq(big4.remaining(startState(10, 4), 0), 49, 'on the certified route the distance is known exactly');
  eq(big4.remaining(startState(10, 4) + 1, 3), null, 'off the route the board says "unknown", not a guess');
  eq(big4.exact, false, 'and it advertises that it is not exhaustive at click time');
  const sweep4 = metricsFor(8, 4);
  eq(sweep4.kind, 'table', '4^8 = 65536 is exactly the sweep budget');
  eq(sweep4.remaining(startState(8, 4), 0), 33, 'swept four-peg distance');
  throws(() => metricsFor(11, 4), 'a four-peg, 11-disk board cannot be measured here, so it is refused');
}

section('solve: the graph itself is well formed');
{
  const t = table(4, 3);
  eq(t.size, 81, 'four disks, three pegs: 3^4 positions');
  let byHand = 0;
  for (let s2 = 0; s2 < t.size; s2++) byHand += legalMoves(s2, 4, 3).length;
  eq(t.edges, byHand, 'the sweep counts exactly the transitions game.js calls legal');
  const t5 = table(5, 3);
  let byHand5 = 0;
  for (let s2 = 0; s2 < t5.size; s2++) byHand5 += legalMoves(s2, 5, 3).length;
  eq(t5.edges, byHand5, 'and again for 3^5 = 243 positions');
  // Degree argument, hand-typed: on three pegs the smallest disk always has two hops, and the
  // two pegs that do not hold it always have exactly one legal move between them — unless both
  // are empty, i.e. the position is a perfect tower. So 3·states − 3.
  eq(byHand, 3 * t.size - 3, 'three pegs, n=4: 3 legal moves per position except the 3 perfect towers (81 → 240)');
  eq(byHand5, 3 * t5.size - 3, 'same argument at n=5 (243 → 726)');
  const reachable = t.dist.filter((d) => d >= 0).length;
  eq(reachable, t.size, 'no position is stranded: every encoding is playable');
  const goalPeg = 2;
  let encoded = 0;
  for (let s = 0; s < t.size; s++) {
    const digits = decode(s, 4, 3);
    if (digits.length === 4 && digits.every((p, d) => p === pegOf(s, d, 3))) encoded++;
  }
  eq(encoded, t.size, 'encode/decode round-trips over the whole graph');
  eq(legalMoves(startState(4, 3), 4, 3).length, 2, 'the full tower offers exactly the two small-disk hops');
  eq(legalMoves(goalState(4, 3), 4, 3).length, 2, '…and so does the finished tower');
  notThrows(() => dist3(0, 4, goalPeg), 'dist3 accepts a plain three-peg position');
  throws(() => dist3(0, 4, 3), 'dist3 refuses a goal peg it cannot express');
}

const c = run();
process.exit(c.fails ? 1 : 0);
