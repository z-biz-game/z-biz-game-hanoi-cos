// The measurement layer — the reason this repo is allowed to print numbers.
//
// Three independent machines live in this file, and the whole design goal is that no number
// the game prints is produced by only one of them:
//
//   1. `bfsTable`  — an exhaustive breadth-first sweep of the *whole* state graph (all
//      `pegs^n` positions), rooted at the goal, so `dist[s]` is the true minimum number of
//      moves from `s` to the finished tower. The largest graph this repo ever walks is
//      `EXHAUST_LIMIT = 3^13 = 1,594,323` positions; measured on this machine that costs
//      ~130 ms and 6 MB for `dist`, which is why the cap is a state count and not a disk
//      count. `tools/bake.mjs` re-solves every published level with it.
//   2. `closedForm3` / `dist3` — arithmetic. `2^n − 1` for the canonical three-peg tower, and
//      `dist3` an O(n) recursion for the distance from *any* three-peg position to the
//      finished tower. `test/solve.test.mjs` checks `dist3` against the BFS over every one of
//      the 3,279 positions of the graphs n = 1..7, so the recursion is not trusted, it is
//      measured — and it is what lets the browser hand out a provably exact "moves left" for
//      a 13-disk board without searching a million states on the player's clock.
//   3. `frameStewart` / `fsRoute` — the four-peg recursion `FS(n) = min_k 2·FS(n−k) + (2^k−1)`
//      and the route it constructs. The route proves the number is *reachable*; the BFS proves
//      nothing shorter exists (which is only possible while the graph fits, i.e. n ≤ 10 four
//      pegs — exactly where the published Reve values live, and the reason the campaign stops
//      at 10 disks on four pegs).
//
// `bfsTable(n, pegs, { strict: false })` exists for one purpose: the counter-proof in
// test/solve.test.mjs that removes "a larger disk may not rest on a smaller one" and must then
// find a *shorter* optimum. It is not wired into the game, and if that test ever goes away the
// option should too.

import {
  applyMove, canMove, goalState, legalMoves, pegOf, startState,
  MAX_DISKS, MAX_PEGS, MIN_PEGS,
} from './game.js';

// The one number this repo draws the line at: 3^13, the largest state graph that is finished
// rather than estimated. Anything asking for more gets a `metricsFor` throw, a bake failure,
// or (four pegs, n ≤ 10) a route-only proof — see DESIGN.md 2.
export const EXHAUST_LIMIT = 3 ** 13; // 1594323, hand-verified: probe5 / test/solve.test.mjs

// The largest graph the *browser* sweeps when a level opens: `4^8 = 65,536` positions,
// measured at ~10 ms and 1 MB here. Below it a board gets an exhaustive distance table and,
// for three pegs, a position-by-position cross-check of the recursion against that sweep on
// the player's own device. Above it the three-peg recursion still answers exactly (no search),
// and a four-peg board falls back to the route-only branch below.
export const TABLE_BUDGET = 4 ** 8; // 65536

export function stateCount(n, pegs = 3) {
  return pegs ** n;
}

export function fitsExhaustive(n, pegs = 3) {
  return stateCount(n, pegs) <= EXHAUST_LIMIT;
}

// ---------- 1. exhaustive BFS over the whole graph ----------------------------------------
export function bfsTable(n, pegs = 3, { strict = true, ways = false, root = null } = {}) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISKS) throw new Error(`bfsTable(${n}): disk count out of range`);
  if (!Number.isInteger(pegs) || pegs < MIN_PEGS || pegs > MAX_PEGS) throw new Error(`bfsTable: peg count ${pegs} out of range`);
  const size = stateCount(n, pegs);
  if (size > EXHAUST_LIMIT) {
    throw new Error(`bfsTable(${n}, ${pegs}): ${size} positions exceeds the ${EXHAUST_LIMIT} cap`);
  }
  const r = root === null ? goalState(n, pegs) : root;
  const pow = new Float64Array(n);
  for (let d = 0; d < n; d++) pow[d] = pegs ** d;
  const dist = new Int32Array(size).fill(-1);
  const nextDisk = new Int32Array(size).fill(-1);
  const nextTo = new Int8Array(size).fill(-1);
  const routeCount = ways ? new Float64Array(size) : null;
  const queue = new Int32Array(size); // a BFS queue over `size` nodes never holds one twice
  let head = 0;
  let tail = 0;
  let edges = 0;
  dist[r] = 0;
  if (routeCount) routeCount[r] = 1;
  queue[tail++] = r;
  const tops = new Int32Array(pegs);
  while (head < tail) {
    const s = queue[head++];
    tops.fill(-1);
    for (let d = 0; d < n; d++) {
      const p = Math.floor(s / pow[d]) % pegs;
      if (tops[p] === -1 || d < tops[p]) tops[p] = d;
    }
    for (let p = 0; p < pegs; p++) {
      const d = tops[p];
      if (d === -1) continue;
      for (let t = 0; t < pegs; t++) {
        if (t === p) continue;
        if (strict && tops[t] !== -1 && tops[t] < d) continue;
        edges++;
        const ns = s + (t - p) * pow[d];
        if (dist[ns] === -1) {
          dist[ns] = dist[s] + 1;
          nextDisk[ns] = d;
          nextTo[ns] = p; // back the way it came: disk d from t onto p
          if (routeCount) routeCount[ns] = routeCount[s];
          queue[tail++] = ns;
        } else if (routeCount && dist[ns] === dist[s] + 1) {
          routeCount[ns] += routeCount[s];
        }
      }
    }
  }
  let maxDist = -1;
  let argMaxDist = -1;
  for (let s = 0; s < size; s++) {
    if (dist[s] > maxDist) {
      maxDist = dist[s];
      argMaxDist = s;
    }
  }
  return {
    n,
    pegs,
    size,
    root: r,
    strict,
    dist,
    nextDisk,
    nextTo,
    routeCount,
    reached: tail,
    complete: tail === size,
    edges,
    maxDist,
    argMaxDist,
  };
}

// The table the game and the tests read, built once per (n, pegs) and cached.
const cache = new Map();
export function table(n, pegs = 3) {
  const key = `${n}:${pegs}`;
  let t = cache.get(key);
  if (!t) {
    t = bfsTable(n, pegs, { ways: stateCount(n, pegs) <= 3 ** 10 });
    cache.set(key, t);
  }
  return t;
}

// ---------- 2. three pegs, by arithmetic --------------------------------------------------
// The canonical tower: 2^n − 1. Exact in doubles for the n this repo ships.
export function closedForm3(n) {
  if (!Number.isInteger(n) || n < 1 || n > 40) throw new Error(`closedForm3(${n}): out of range`);
  return 2 ** n - 1;
}

// Distance from ANY three-peg position to the finished tower, in O(n).
//
// The induction is the classical one and it is the whole reason the number is a bound rather
// than a guess: look at the largest disk that is not where it belongs. Before it can move,
// every smaller disk must be stacked on the one peg that is neither under it nor its target;
// after it moves, those smaller disks have to be brought onto it, which is exactly 2^k − 1
// moves for k smaller disks. Nothing else can be shorter, because the largest misplaced disk
// has to move at least once and the two packing tasks are unavoidable.
// test/solve.test.mjs checks this against the exhaustive BFS over every position of every
// graph up to n = 7, so "the proof is right" is a measurement here, not a claim.
export function dist3(state, n, goalPeg = 2) {
  if (goalPeg < 0 || goalPeg > 2) throw new Error('dist3 is a three-peg function');
  let acc = 0;
  let target = goalPeg;
  for (let m = n - 1; m >= 0; m--) {
    const p = pegOf(state, m, 3);
    if (p === target) continue;              // this disk is already home
    const u = 3 - p - target;                // the peg that is neither
    acc += 2 ** m;                           // 1 to move disk m, then 2^m − 1 to follow it
    target = u;                              // and every smaller disk must reach u first
  }
  return acc;
}

function stacked(digits, k, peg) {
  for (let d = 0; d < k; d++) if (digits[d] !== peg) return false;
  return true;
}

// The first move of a shortest route from any three-peg position; null when already solved.
// Descends the same recursion as `dist3`, and stops at the largest disk that can actually go
// now — which is exactly when the smaller disks it was waiting for are already stacked.
export function next3Move(state, n, goalPeg = 2) {
  const digits = new Int8Array(n);
  for (let d = 0; d < n; d++) digits[d] = pegOf(state, d, 3);
  if (stacked(digits, n, goalPeg)) return null;
  let m = n;
  let target = goalPeg;
  for (;;) {
    m--;
    if (m < 0) return null; // unreachable given the invariant below; never spin past the end
    const p = digits[m];
    if (p === target) continue;
    const u = 3 - p - target;
    if (stacked(digits, m, u)) return { disk: m, from: p, to: target };
    target = u;
  }
}

// ---------- 3. four pegs: Frame-Stewart --------------------------------------------------
// FS(0) = 0, FS(1) = 1, FS(m) = min over 1 ≤ k < m of 2·FS(m−k) + (2^k − 1).
// The published values for n = 1..12 are pinned by hand in test/solve.test.mjs, including
// FS(10) = 49, the classic ten-disk Reve's puzzle.
export const FS_PUBLISHED_MAX = 12; // beyond this nobody has proved FS optimal; we ship nothing
export const FS_RANGE = [1, 3, 5, 9, 13, 17, 25, 33, 41, 49, 65, 81];

export function frameStewart(maxN = FS_PUBLISHED_MAX) {
  if (!Number.isInteger(maxN) || maxN < 1 || maxN > FS_PUBLISHED_MAX) {
    throw new Error(`frameStewart: n beyond the published range (1..${FS_PUBLISHED_MAX})`);
  }
  const f = [0, 1];
  for (let m = 2; m <= maxN; m++) {
    let best = Infinity;
    for (let k = 1; k < m; k++) best = Math.min(best, 2 * f[m - k] + (2 ** k - 1));
    f[m] = best;
  }
  return f;
}

export function fsPar(n) {
  if (n === 1) return 1;
  return frameStewart(n)[n];
}

// The `k` the recursion chose, so `fsRoute` and `fsPar` can never drift apart. Memoised
// because `fsRoute` asks for every sub-size on the way down and `frameStewart` refuses to
// answer above the published range.
const fsMemo = new Map();
function fsTable(maxN) {
  let hit = fsMemo.get(maxN);
  if (hit && hit.f.length > maxN) return hit.f;
  const f = frameStewart(maxN);
  fsMemo.set(maxN, { f });
  return f;
}

function fsSplit(m) {
  if (m <= 1) return 1;
  const f = fsTable(m);
  let best = Infinity;
  let bk = 1;
  for (let k = 1; k < m; k++) {
    const v = 2 * f[m - k] + (2 ** k - 1);
    if (v < best) {
      best = v;
      bk = k;
    }
  }
  if (best !== f[m]) throw new Error(`fsSplit(${m}): split ${bk} costs ${best}, FS says ${f[m]}`);
  return bk;
}

// The constructive route: move the top m−k disks aside with all four pegs, move the k largest
// with three pegs while those sit untouched, then bring the top ones down. Length is FS(m) by
// construction, and `replayRoute` proves it is a legal play.
export function fsRoute(n, pegs = 4) {
  if (!Number.isInteger(n) || n < 1 || n > FS_PUBLISHED_MAX) throw new Error(`fsRoute(${n}): out of range`);
  if (pegs < MIN_PEGS || pegs > MAX_PEGS) throw new Error(`fsRoute: peg count ${pegs} out of range`);
  const moves = [];
  const three = (m, from, to, spare, off) => {
    if (m === 0) return;
    three(m - 1, from, spare, to, off);
    moves.push({ disk: off + m - 1, from, to });
    three(m - 1, spare, to, from, off);
  };
  const walk = (m, from, to, spares, off) => {
    if (m === 0) return;
    if (spares.length < 2) {
      three(m, from, to, spares[0], off);
      return;
    }
    const k = fsSplit(m);
    const p1 = spares[0];
    const p2 = spares[1];
    walk(m - k, from, p1, [to, p2], off);
    three(k, from, to, p2, off + m - k);
    walk(m - k, p1, to, [from, p2], off);
  };
  const from = 0;
  const to = pegs - 1;
  const others = [];
  for (let p = 0; p < pegs; p++) if (p !== from && p !== to) others.push(p);
  walk(n, from, to, others, 0);
  return moves;
}

// Replay a route through the *same* predicate a finger is held to. Returns the states it
// passes through, or throws — an illegal "certified solution" is a build failure, not a note.
export function replayRoute(n, pegs, moves, start = startState(n, pegs)) {
  const states = [start];
  let s = start;
  for (const mv of moves) {
    if (!canMove(s, mv.disk, mv.to, n, pegs)) {
      throw new Error(`route illegal at move ${states.length}: disk ${mv.disk + 1} ${mv.from}→${mv.to} from state ${s}`);
    }
    s = applyMove(s, mv.disk, mv.to, n, pegs);
    states.push(s);
  }
  return { end: s, states, moves: moves.length };
}

export function routeCount(n, pegs = 3) {
  const t = table(n, pegs);
  if (!t.routeCount) return null;
  return t.routeCount[startState(n, pegs)];
}

// ---------- 4. what a level knows about its own distance ---------------------------------
//
// Cached per (n, pegs, goal, start): the table branch sweeps a graph and the three-peg branch
// cross-checks every position of it, neither of which should be repeated for every level load.
const metricsCache = new Map();
//
// `metricsFor` is the policy door, and its three branches are the honest answer to "can this
// position's distance be computed right now?":
//
//   * table    — the graph fits in TABLE_BUDGET, so the browser sweeps it exhaustively on
//                level open (3^8 = 6561 positions ≈ 0.2 ms; 4^8 = 65536 ≈ 10 ms). Exact
//                distance and exact hint, and for three pegs the sweep is additionally
//                checked against the recursion so the two instruments cannot disagree.
//   * dist3    — three pegs, big graph: O(n) exact distance, no search at all.
//   * route    — four pegs, n = 9 or 10: 262 k / 1 M positions, not searched on anyone's
//                clock. `par` is still a *proven* bound because tools/bake.mjs swept the
//                whole graph at build time; `remaining` is only reported while the player is
//                still following the certified route, and says null (an em dash on screen)
//                the moment they leave it.
export function metricsFor(n, pegs, goal = goalState(n, pegs), start = startState(n, pegs)) {
  const key = `${n}|${pegs}|${goal}|${start}`;
  let m = metricsCache.get(key);
  if (!m) {
    m = buildMetrics(n, pegs, goal, start);
    metricsCache.set(key, m);
  }
  return m;
}

function buildMetrics(n, pegs, goal, start) {
  const size = stateCount(n, pegs);
  if (size <= TABLE_BUDGET) {
    const t = table(n, pegs);
    if (t.root !== goal) throw new Error(`metricsFor: table is rooted at ${t.root}, level wants goal ${goal}`);
    if (pegs === 3) {
      // Two instruments over the same graph, checked position by position on this device.
      for (let s = 0; s < t.size; s++) {
        const d3 = dist3(s, n, goalPegOf(goal, n, pegs));
        if (t.dist[s] !== d3) {
          throw new Error(`metricsFor: BFS ${t.dist[s]} disagrees with dist3 ${d3} at state ${s}`);
        }
      }
    }
    return {
      kind: 'table',
      exact: true,
      states: size,
      proof: `浏览器穷尽 BFS ${size} 态，与${pegs === 3 ? '闭式递推逐位' : '构建期递推'}对账`,
      remaining: (s) => t.dist[s],
      next: (s) => (t.nextDisk[s] < 0 ? null : { disk: t.nextDisk[s], from: pegOf(s, t.nextDisk[s], pegs), to: t.nextTo[s] }),
      verifiedBySweep: true,
    };
  }
  if (pegs === 3 && size <= EXHAUST_LIMIT) {
    const g = goalPegOf(goal, n, pegs);
    return {
      kind: 'dist3',
      exact: true,
      states: size,
      proof: `闭式 2^${n}−1 + O(n) 递推（n≤7 的 3279 个位置已与穷尽 BFS 逐位对账）`,
      remaining: (s) => dist3(s, n, g),
      next: (s) => next3Move(s, n, g),
    };
  }
  if (pegs === 4 && n >= 9 && n <= 10) {
    const moves = fsRoute(n, pegs);
    const { states } = replayRoute(n, pegs, moves, start);
    return {
      kind: 'route',
      exact: false,
      states: size,
      proof: `构建期穷尽 BFS ${size} 态（tools/bake.mjs）；浏览器内只走认证路线`,
      route: moves,
      routeStates: states,
      remaining: (s, movesSoFar) => (states[movesSoFar] === s ? moves.length - movesSoFar : null),
      next: (s, movesSoFar) => (states[movesSoFar] === s && moves[movesSoFar] ? moves[movesSoFar] : null),
    };
  }
  throw new Error(`metricsFor(${n}, ${pegs}): ${size} positions exceeds ${EXHAUST_LIMIT}; no measurement is possible and none is printed`);
}

// The goal of a canonical tower is every digit = pegs-1, i.e. the state `pegs^n − 1`; a
// scrambled row keeps the same goal, so this is well defined for every row this repo ships.
function goalPegOf(goal, n, pegs) {
  if (goal !== goalState(n, pegs)) throw new Error('this repo plays to the canonical finished tower only');
  return pegs - 1;
}

// What the shell prints about the game as a whole, and what @boot asserts. Deliberately does
// NOT sweep the big graphs: the browser's right to search is capped at TABLE_BUDGET here, and
// EXHAUST_LIMIT is a build-time promise.
export function census() {
  const three = table(7, 3);
  const four = table(6, 4);
  return {
    limit: EXHAUST_LIMIT,
    tableBudget: TABLE_BUDGET,
    three: {
      n: three.n,
      states: three.size,
      reached: three.reached,
      complete: three.complete,
      edges: three.edges,
      par: three.dist[startState(7, 3)],
      closedForm: closedForm3(7),
      maxDist: three.maxDist,
      argMaxDist: three.argMaxDist,
      routeCount: three.routeCount ? three.routeCount[startState(7, 3)] : null,
      agreesWithRecursion: (() => {
        for (let s = 0; s < three.size; s++) if (three.dist[s] !== dist3(s, 7, 2)) return false;
        return true;
      })(),
    },
    four: {
      n: four.n,
      states: four.size,
      reached: four.reached,
      complete: four.complete,
      par: four.dist[startState(6, 4)],
      frameStewart: FS_RANGE[5],
    },
    legalMoves: legalMoves(startState(7, 3), 7, 3),
  };
}
