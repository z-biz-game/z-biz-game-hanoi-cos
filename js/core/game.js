// The rules of 汉诺塔 and nothing else.
//
// A position is `pegs`-ary digits: digit `d` is the peg holding disk `d`, where disk 0 is the
// *smallest* disk and disk n-1 the largest. Encoding a position as one integer is what lets
// js/core/solve.js walk the whole state graph with a typed-array queue — 3^13 = 1,594,323
// positions fit in 6 MB that way, and the same integer is what gets baked into a level row,
// so "the level on disk" and "the level searched" are literally the same number.
//
// There is exactly ONE legality predicate in this repo: `canMove` below. Everything else —
// the BFS, the counter-proof, the view's highlight, the shell's refusal message, the
// `@pointer` assertions — reads it. That is what makes the "抹掉规则最优步数必须变小"
//反证 (test/solve.test.mjs) meaningful: there is no second copy of the rule for a test to
// accidentally pass instead.
//
// No DOM, no window: `node test/*.test.mjs` imports this file directly.

export const MIN_PEGS = 3;
export const MAX_PEGS = 4; // 5+ pegs: Frame-Stewart is not even published there. See DESIGN.md.
export const MAX_DISKS = 13; // 3^13 is the largest graph this repo promises to finish. See solve.js.

export const SMALLEST = 0; // disk index 0, so "smaller disk" means "lower index" everywhere below

// Which peg disk `d` sits on.
export function pegOf(state, d, pegs = 3) {
  return Math.floor(state / pegs ** d) % pegs;
}

// A position as a plain array (the view and the tests read this; nothing re-encodes it by
// hand — `encode` is the only inverse, and test/game.test.mjs round-trips the two).
export function decode(state, n, pegs = 3) {
  const out = new Int8Array(n);
  let s = state;
  for (let d = 0; d < n; d++) {
    out[d] = s % pegs;
    s = Math.floor(s / pegs);
  }
  return out;
}

export function encode(pegs, digits) {
  let s = 0;
  for (let d = digits.length - 1; d >= 0; d--) s = s * pegs + digits[d];
  return s;
}

// For every peg: the index of its top (smallest) disk, or -1 when the peg is empty.
// O(n) per call, which is the only reason a full 1.6 M-state BFS costs 130 ms instead of
// seconds: the BFS computes this once per state and derives all of its moves from it.
export function pegTops(state, n, pegs = 3) {
  const tops = new Int32Array(pegs).fill(-1);
  for (let d = 0; d < n; d++) {
    const p = Math.floor(state / pegs ** d) % pegs;
    if (tops[p] === -1 || d < tops[p]) tops[p] = d;
  }
  return tops;
}

// THE rule, both halves of it:
//   * the disk must be the top of its peg (no smaller disk on the same peg);
//   * the destination must hold no smaller disk (a larger disk may not be put on a smaller one).
export function canMove(state, disk, to, n, pegs = 3, tops = null) {
  if (disk < 0 || disk >= n) return false;
  if (to < 0 || to >= pegs) return false;
  const t = tops || pegTops(state, n, pegs);
  const from = pegOf(state, disk, pegs);
  if (to === from) return false;
  if (t[from] !== disk) return false; // buried
  return t[to] === -1 || t[to] > disk; // receiving peg must not carry something smaller
}

// Every legal single move from a position, as {disk, from, to}.
export function legalMoves(state, n, pegs = 3) {
  const tops = pegTops(state, n, pegs);
  const out = [];
  for (let p = 0; p < pegs; p++) {
    const d = tops[p];
    if (d === -1) continue;
    for (let t = 0; t < pegs; t++) {
      if (t === p) continue;
      if (tops[t] !== -1 && tops[t] < d) continue;
      out.push({ disk: d, from: p, to: t });
    }
  }
  return out;
}

export function applyMove(state, disk, to, n, pegs = 3) {
  const from = pegOf(state, disk, pegs);
  return state + (to - from) * pegs ** disk;
}

// The finished tower: every disk on the last peg, i.e. every digit = pegs-1.
export function goalState(n, pegs = 3) {
  return pegs ** n - 1;
}

// The canonical start: every disk on the first peg.
export function startState(n, pegs = 3) {
  return 0;
}

export function isGoal(state, n, pegs = 3) {
  return state === goalState(n, pegs);
}

export function diskWidth(disk, n) {
  // View-only arithmetic would belong to js/view.js, but the panel prints the disk count in
  // words and the test hooks report widths, so it is a pure number here. Linear in diameter,
  // which is what the spec's "宽度按直径线性" asks for.
  return 0.28 + 0.72 * (disk / Math.max(1, n - 1));
}

// A level in the shape `createGame` wants. `metrics` is built by js/core/solve.js and carried
// by the level: which way of measuring "moves left" this position affords (an exact recursion
// for three pegs, an exhaustive table for small four-peg graphs, or nothing but the proven
// par for the one big graph the browser will not search). game.js never imports solve.js, so
// there is no cycle and no place for the two to disagree about the rule.
export function createGame(level) {
  if (!level || !Number.isInteger(level.n) || !Number.isInteger(level.pegs)) {
    throw new Error('createGame needs a level with n and pegs');
  }
  const game = {
    id: level.id,
    tier: level.tier,
    n: level.n,
    pegs: level.pegs,
    par: level.par,
    goal: level.goal,
    metrics: level.metrics || null,
    start: level.start,
    state: level.start,
    moves: 0,
    history: [],
    refused: 0,
    done: level.start === level.goal,
  };
  return game;
}

// One move, judged by the rule and by nothing else. Returns true when the disk actually
// travelled and the move is billed; false means the rule refused it, in which case the
// position, the counter and the history are untouched — the view may shake, that is all.
export function move(game, disk, to) {
  if (game.done) {
    game.refused++;
    return false;
  }
  if (!canMove(game.state, disk, to, game.n, game.pegs)) {
    game.refused++;
    return false;
  }
  const from = pegOf(game.state, disk, game.pegs);
  const before = game.state;
  game.state = applyMove(before, disk, to, game.n, game.pegs);
  game.history.push({ disk, from, to, before, after: game.state });
  game.moves++;
  if (game.state === game.goal) game.done = true;
  return true;
}

// The interaction the screen actually offers: lift the top disk of peg `from` onto peg `to`.
// Same door as `move`, so a drag and a click and a test replay all get held to one rule.
export function moveTop(game, from, to) {
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= game.pegs || to < 0 || to >= game.pegs) return false;
  // Out-of-range pegs are not a refusal of the rule but of the gesture; the view clamps drags at
  // the border, so this guard is the last line and stays unbilled either way.
  const tops = pegTops(game.state, game.n, game.pegs);
  const disk = tops[from];
  if (disk < 0) {
    game.refused++;
    return false; // an empty peg holds nothing to lift
  }
  if (!canMove(game.state, disk, to, game.n, game.pegs, tops)) {
    game.refused++;
    return false;
  }
  return move(game, disk, to);
}

export function undo(game) {
  const last = game.history.pop();
  if (!last) return false;
  game.state = last.before;
  game.moves--;
  game.done = false;
  return true;
}

export function reset(game) {
  game.state = game.start;
  game.moves = 0;
  game.history = [];
  game.done = game.start === game.goal;
}

// Moves left on a shortest route, or null when this repo does not know one exactly (see the
// comment on `createGame`). A null never becomes a 0 by accident: the shell prints an em dash.
export function remaining(game) {
  const m = game.metrics;
  if (!m || typeof m.remaining !== 'function') return null;
  return m.remaining(game.state, game.moves);
}

// The number the win card and the record are judged against. Only ever compared with `par`,
// which is why an unknown distance must not silently read as "on par".
export function overPar(game) {
  const left = remaining(game);
  if (left === null) return Math.max(0, game.moves - game.par);
  return Math.max(0, game.moves + left - game.par);
}

export function nextMove(game) {
  const m = game.metrics;
  if (!m || typeof m.next !== 'function') return null;
  return m.next(game.state, game.moves);
}

export function hint(game) {
  const mv = nextMove(game);
  if (!mv) return null;
  return { ...mv, left: remaining(game) };
}

export function isExact(game) {
  return !!(game.metrics && game.metrics.exact);
}

// Grades are defined against the measured par, so the win card and the tests read one rule.
// `steps === par` is the certified solution: fewer is impossible by the proof bake.mjs ran,
// more means the player finished but missed the proven bound.
export function grade(game) {
  const over = game.moves - game.par;
  if (over === 0) return { key: 'certified', label: '认证解', stars: 3 };
  if (over <= 3) return { key: 'clean', label: '顺手塔成', stars: 2 };
  return { key: 'long', label: '历尽重塔', stars: 1 };
}

export function describeMove(mv, pegNames = null) {
  const names = pegNames || ['A', 'B', 'C', 'D'];
  return `第 ${mv.disk + 1} 号盘 ${names[mv.from]} → ${names[mv.to]}`;
}
