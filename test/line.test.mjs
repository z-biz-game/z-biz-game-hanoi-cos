// 线柱 (adjacent-peg Hanoi): the three-peg game with one extra restriction — a disk may only hop
// to a neighbouring peg. Every literal below was typed by hand from the published optimum for
// that puzzle (corner→corner 3^n−1, corner→middle (3^n−1)/2), and the recurrences are re-derived
// locally from the shape of the problem. Nothing here is read back out of js/core/solve.js, so a
// green run means the shipped sweep agrees with an outside statement about the world.

import { ok, eq, deepEq, throws, notThrows, run, section } from '../tools/harness.mjs';
import {
  applyMove, canMove, createGame, encode, goalState, legalMoves, moveTop, overPar, pegOf,
  pegStepOk, remaining, ruleSupported, startState,
} from '../js/core/game.js';
import {
  EXHAUST_LIMIT, TABLE_BUDGET, LINE_FORM_MAX_N, bfsTable, closedFormLine,
  closedFormLineHalf, dist3, metricsFor, routeCount, stateCount, table,
} from '../js/core/solve.js';
import { canonicalLevel } from '../js/core/make.js';

// ---- hand-typed anchors ---------------------------------------------------------------------
// corner → corner, n = 1..13:  3^n − 1
const LINE_CORNER_TO_CORNER = [2, 8, 26, 80, 242, 728, 2186, 6560, 19682, 59048, 177146, 531440, 1594322];
// corner → middle, n = 1..13:  (3^n − 1) / 2
const LINE_CORNER_TO_MIDDLE = [1, 4, 13, 40, 121, 364, 1093, 3280, 9841, 29524, 88573, 265720, 797161];
// the same game without the adjacency restriction, for the "does the rule bind" section
const FREE_PAR_ONE_TO_EIGHT = [1, 3, 7, 15, 31, 63, 127, 255];

// Recurrences, derived by hand and computed here — a third instrument, not a restatement:
//   T(n): the largest disk must cross 0→1 and then 1→2, and each crossing needs the n−1 smaller
//         disks parked on the far peg first ⟹ T(n) = 3·T(n−1) + 2, T(1) = 2.
//   S(n): park the n−1 smaller disks on the far corner (T(n−1)), step the largest disk one peg,
//         then bring the small tower down onto it (S(n−1)) ⟹ S(n) = T(n−1) + 1 + S(n−1), S(1) = 1.
function recurrences(maxN) {
  const T = [0, 2];
  const S = [0, 1];
  for (let n = 2; n <= maxN; n++) {
    T[n] = 3 * T[n - 1] + 2;
    S[n] = T[n - 1] + 1 + S[n - 1];
  }
  return { T, S };
}

section('line: the closed forms against hand-typed anchors and recurrences');
{
  const { T, S } = recurrences(13);
  for (let n = 1; n <= 13; n++) {
    eq(closedFormLine(n), LINE_CORNER_TO_CORNER[n - 1], `closedFormLine(${n}) = 3^${n}−1 = ${LINE_CORNER_TO_CORNER[n - 1]}`);
    eq(closedFormLineHalf(n), LINE_CORNER_TO_MIDDLE[n - 1], `closedFormLineHalf(${n}) = (3^${n}−1)/2 = ${LINE_CORNER_TO_MIDDLE[n - 1]}`);
    eq(T[n], LINE_CORNER_TO_CORNER[n - 1], `recurrence T(${n}) matches the typed corner→corner anchor`);
    eq(S[n], LINE_CORNER_TO_MIDDLE[n - 1], `recurrence S(${n}) matches the typed corner→middle anchor`);
    eq(closedFormLine(n), 2 * closedFormLineHalf(n), `n=${n}: 2·S(n) = T(n), the two roads meet`);
  }
  throws(() => closedFormLine(0), 'closedFormLine rejects n = 0');
  throws(() => closedFormLineHalf(LINE_FORM_MAX_N + 1), `closedFormLineHalf stops where doubles stay exact (n > ${LINE_FORM_MAX_N})`);
}

section('line: exhaustive BFS reproduces corner→corner, n = 1..13');
for (let n = 1; n <= 13; n++) {
  const t = bfsTable(n, 3, { ways: stateCount(n, 3) <= 3 ** 10, rule: 'line' });
  const start = startState(n, 3);
  eq(t.dist[start], LINE_CORNER_TO_CORNER[n - 1], `BFS corner→corner for ${n} disks, neighbours only`);
  ok(t.complete, `BFS visited all ${t.size} positions for n = ${n} under the line rule`);
  eq(t.reached, stateCount(n, 3), `the line graph is connected: queue drained exactly the state space, n = ${n}`);
  eq(t.dist[goalState(n, 3)], 0, `n = ${n}: the finished tower is at distance 0`);
  eq(t.maxDist, LINE_CORNER_TO_CORNER[n - 1], `n = ${n}: the start tower is a farthest position from the goal`);
  eq(t.rule, 'line', `n = ${n}: the sweep says which graph it walked`);
}
for (let n = 1; n <= 8; n++) {
  eq(routeCount(n, 3, 'line'), 1, `n = ${n}: exactly one shortest route exists under the line rule`);
}
throws(() => bfsTable(14, 3, { rule: 'line' }), 'bfsTable still refuses a graph it cannot finish, variant included');
throws(() => bfsTable(3, 3, { rule: 'warp' }), 'an unknown policy throws instead of quietly meaning "free"');

section('line: exhaustive BFS reproduces corner→middle, n = 1..13');
for (let n = 1; n <= 13; n++) {
  const middleTower = encode(3, new Array(n).fill(1));
  eq(middleTower, LINE_CORNER_TO_MIDDLE[n - 1], `n = ${n}: "every disk on peg 1" encodes to (3^${n}−1)/2 = ${middleTower}`);
  const t = bfsTable(n, 3, { root: middleTower, rule: 'line' });
  eq(t.dist[startState(n, 3)], LINE_CORNER_TO_MIDDLE[n - 1], `BFS corner→middle for ${n} disks`);
  ok(t.complete, `n = ${n}: rooted at the middle tower the sweep still covers all ${t.size} positions`);
  eq(t.maxDist, LINE_CORNER_TO_MIDDLE[n - 1], `n = ${n}: from the middle tower the corner tower is farthest`);
}

section('line: the restriction binds — measured against the free graph');
for (let n = 1; n <= 8; n++) {
  const free = bfsTable(n, 3);
  const line = bfsTable(n, 3, { rule: 'line' });
  const start = startState(n, 3);
  eq(free.dist[start], FREE_PAR_ONE_TO_EIGHT[n - 1], `n = ${n}: the free graph is unchanged by this patch`);
  ok(line.dist[start] > free.dist[start], `n = ${n}: adjacency makes the optimum longer (${line.dist[start]} > ${free.dist[start]})`);
  ok(line.edges < free.edges, `n = ${n}: adjacency makes the graph sparser (${line.edges} edges < ${free.edges})`);
}
{
  const n = 4;
  const start = startState(n, 3);
  eq(legalMoves(start, n, 3, 'line').length, 1, 'the full tower offers exactly one hop under the line rule');
  eq(legalMoves(start, n, 3).length, 2, '…and two without it');
  eq(canMove(start, 0, 2, n, 3, null, 'line'), false, 'corner→corner is refused');
  eq(canMove(start, 0, 1, n, 3, null, 'line'), true, 'corner→middle is allowed');
  eq(canMove(start, 0, 2, n, 3), true, 'the same hop is legal in the published game');
  deepEq(legalMoves(start, n, 3, 'line'), [{ disk: 0, from: 0, to: 1 }], 'the one move is the smallest disk onto the middle peg');
  ok(legalMoves(startState(5, 3), 5, 3, 'line').every((m) => Math.abs(m.to - m.from) === 1), 'no generated move skips a peg');
  eq(pegStepOk(0, 2, 'line'), false, 'pegStepOk: corners are not neighbours');
  eq(pegStepOk(0, 2, 'free'), true, 'pegStepOk: free bills any pair');
  throws(() => pegStepOk(0, 1, 'sideways'), 'pegStepOk throws on a policy it does not know');
}

section('line: the swept graph and the played graph are the same graph');
// bfsTable inlines the move generation for speed, so this is the guard that the inlined copy and
// `legalMoves` (the predicate a finger is held to) produce one edge set: same count, and every
// predicate move lands exactly one distance layer away. Measured to be *exactly* 1 — there is not
// one same-layer edge in these graphs, which is what makes "wasted moves" countable on screen.
{
  let states = 0;
  let movesChecked = 0;
  let layerBad = 0;
  let edgeBad = 0;
  for (let n = 1; n <= 7; n++) {
    const t = table(n, 3, 'line');
    let byPredicate = 0;
    for (let s = 0; s < t.size; s++) {
      states++;
      for (const mv of legalMoves(s, n, 3, 'line')) {
        const ns = applyMove(s, mv.disk, mv.to, n, 3);
        if (Math.abs(t.dist[ns] - t.dist[s]) !== 1) layerBad++;
        movesChecked++;
        byPredicate++;
      }
    }
    if (t.edges !== byPredicate) edgeBad++;
  }
  eq(edgeBad, 0, 'sweep edge count equals the predicate move count for every n from 1 to 7');
  eq(layerBad, 0, 'every predicate move changes the swept distance by exactly one layer');
  ok(states > 2000, `${states} positions checked position by position across n = 1..7`);
  ok(movesChecked > 4000, `${movesChecked} predicate moves re-read against the swept distances`);
}

section('line: the route the table hands out replays through the rule');
for (let n = 1; n <= 9; n++) {
  const lv = canonicalLevel(3, n, `lot-line-${n}`, 'line');
  eq(lv.par, LINE_CORNER_TO_CORNER[n - 1], `make.js measures the same corner→corner par for n = ${n}`);
  eq(lv.closedFormLine, LINE_CORNER_TO_CORNER[n - 1], `n = ${n}: the row carries its own arithmetic witness`);
  eq(lv.closedForm, null, `n = ${n}: a 线柱 row never borrows the 2^n−1 column`);
  const game = createGame(lv);
  let illegal = 0;
  let skipped = 0;
  let steps = 0;
  while (!game.done && steps <= lv.par) {
    const mv = game.metrics.next(game.state, game.moves);
    if (!mv) break;
    if (Math.abs(mv.to - mv.from) !== 1) skipped++;
    if (!moveTop(game, mv.from, mv.to)) illegal++;
    steps++;
  }
  eq(steps, lv.par, `n = ${n}: the certified route is exactly par moves long`);
  eq(illegal, 0, `n = ${n}: the rule accepted every step of the route it advertised`);
  eq(skipped, 0, `n = ${n}: no step of the route hops over the middle peg`);
  eq(game.moves, lv.par, `n = ${n}: every step was billed`);
  eq(game.refused, 0, `n = ${n}: nothing was refused`);
  eq(overPar(game), 0, `n = ${n}: the certified route finishes on par`);
  eq(game.state, goalState(n, 3), `n = ${n}: the route ends on the finished tower`);
}
{
  // A wasted move is not a plateau: under this rule every legal move changes the exact distance by
  // one layer, so the HUD's 超支 counter moves by a predictable 0 or 2.
  const lv = canonicalLevel(3, 5, 'lot-line-5', 'line');
  const game = createGame(lv);
  eq(remaining(game), LINE_CORNER_TO_CORNER[4], 'the HUD opens at par moves left');
  const toward = game.metrics.next(game.state, 0);
  ok(moveTop(game, toward.from, toward.to), 'the first step of the certified route is accepted');
  eq(overPar(game), 0, 'one step toward the goal: still on par');
  const away = legalMoves(game.state, game.n, game.pegs, 'line').find(
    (m) => game.metrics.remaining(applyMove(game.state, m.disk, m.to, game.n, game.pegs)) === remaining(game) + 1,
  );
  ok(!!away, 'a step away from the goal exists at this position');
  moveTop(game, away.from, away.to);
  eq(overPar(game), 2, 'one step away from the goal costs exactly two — it has to be undone');
  eq(game.moves, 2, 'the two moves are billed as two');
}

section('line: what this repo refuses to print');
{
  const n10 = 10; // 3^10 = 59,049 positions — still inside the browser's own sweep
  const n11 = 11; // 177,147 — over TABLE_BUDGET, and dist3 assumes a disk can hop anywhere
  eq(stateCount(n10, 3), 59049, '3^10 positions');
  eq(stateCount(n11, 3), 177147, '3^11 positions');
  ok(stateCount(n10, 3) <= TABLE_BUDGET, 'n = 10 fits the browser sweep budget');
  ok(stateCount(n11, 3) > TABLE_BUDGET, 'n = 11 does not');
  ok(stateCount(n11, 3) <= EXHAUST_LIMIT, '…though build-time BFS can still finish it');
  const g10 = goalState(n10, 3);
  notThrows(() => metricsFor(n10, 3, g10, startState(n10, 3), 'line'), 'a 线柱 board inside the budget gets an exact table');
  throws(() => metricsFor(n11, 3, goalState(n11, 3), startState(n11, 3), 'line'),
    'a 线柱 board above it gets a refusal, not the free-rule recursion dressed up');
  eq(metricsFor(n10, 3, g10, startState(n10, 3), 'line').exact, true, 'the branch that answers is exact');
  eq(metricsFor(n11, 3, goalState(n11, 3), startState(n11, 3)).kind, 'dist3', 'the published game keeps its O(n) recursion');
  ok(!ruleSupported(4, 'line'), 'four pegs in a row have no published optimum, so nothing ships on them');
  ok(ruleSupported(3, 'line') && ruleSupported(4, 'free'), 'free travels on any peg count, line only on three');
  throws(() => canonicalLevel(4, 5, 'lot-4p-line', 'line'), 'canonicalLevel refuses the unwitnessed shape');
  throws(() => createGame({ n: 4, pegs: 3, start: 0, goal: 3 ** 4 - 1, par: 80, rule: 'warp' }),
    'createGame refuses a policy it does not know, before a single move is played on it');
  // The two instruments must disagree, or the line sweep would be measuring the free graph.
  for (let n = 2; n <= 8; n++) {
    const t = table(n, 3, 'line');
    ok(t.dist[startState(n, 3)] !== dist3(startState(n, 3), n, 2),
      `n = ${n}: dist3 is not a 线柱 instrument (BFS ${t.dist[startState(n, 3)]} vs dist3 ${dist3(startState(n, 3), n, 2)})`);
  }
  // …and the far corner is still where the game ends: the goal peg is the last one either way.
  eq(pegOf(goalState(5, 3), 4, 3), 2, 'the finished tower stands on peg 2, the far corner');
}

const c = run();
process.exit(c.fails ? 1 : 0);
