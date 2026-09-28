// The rule, the counters and nothing else: every assertion here is about what a move does to the
// position, the step counter and the history. Distances themselves are measured in
// test/solve.test.mjs; the table is re-solved in test/library.test.mjs.

import { ok, eq, deepEq, throws, run, section } from '../tools/harness.mjs';
import {
  MAX_DISKS, MAX_PEGS, MIN_PEGS, SMALLEST, applyMove, canMove, createGame, decode, describeMove,
  diskWidth, goalState, grade, hint, isExact, isGoal, legalMoves, move, moveTop, nextMove,
  overPar, pegOf, pegTops, remaining, reset, startState, undo,
} from '../js/core/game.js';
import { canonicalLevel, dailyLevel, makeLevel } from '../js/core/make.js';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const S3 = (n) => startState(n, 3);
const G3 = (n) => goalState(n, 3);

section('game: the state is a base-peg integer, and the disks can be read back out');
eq(pegOf(S3(4), 0, 3), 0, 'every disk of a fresh tower starts on peg 0');
eq(pegOf(G3(4), 3, 3), 2, '…and on the last peg once finished');
deepEq([...decode(G3(4), 4, 3)], [2, 2, 2, 2], 'decode lists one peg per disk, smallest first');
deepEq([...decode(applyMove(S3(4), 0, 1, 4, 3), 4, 3)], [1, 0, 0, 0], 'moving disk 0 to peg 1 changes exactly one digit');
deepEq([...pegTops(G3(4), 4, 3)], [-1, -1, 0], 'pegTops names the smallest disk per peg, -1 when empty');
deepEq([...pegTops(applyMove(S3(2), 0, 1, 2, 3), 2, 3)], [1, 0, -1], 'pegTops: disk 1 on peg 0, disk 0 on top of peg 1');
eq(MIN_PEGS, 3, 'three pegs is the floor (two pegs is not a puzzle)');
eq(MAX_PEGS, 4, 'four pegs is the ceiling (see DESIGN.md: Frame-Stewart is unproven above four)');
eq(MAX_DISKS, 13, 'thirteen disks is the ceiling (3^13 is the largest graph exhausted)');
ok(diskWidth(0, 5) < diskWidth(4, 5), 'the smallest disk is the narrowest');
eq(diskWidth(4, 5) - diskWidth(3, 5) > diskWidth(1, 5) - diskWidth(0, 5) - 1e-9, true, 'width is linear in diameter, so equal steps');

section('game: canMove is the whole rule');
{
  const n = 4;
  const s = S3(n);
  ok(canMove(s, 0, 1, n, 3), 'the bare disk on top of the tower may be lifted to an empty peg');
  ok(!canMove(s, 2, 1, n, 3), 'a buried disk cannot be lifted at all');
  ok(!canMove(s, 0, 0, n, 3), 'a peg is not its own destination');
  ok(!canMove(s, 0, 3, n, 3), 'there is no peg 3 on a three-peg board');
  ok(!canMove(s, 4, 1, n, 3), 'there is no fifth disk');
  ok(!canMove(s, -1, 1, n, 3), 'negative disks do not exist');
  const one = applyMove(s, 0, 1, n, 3);            // disk 0 on peg 1, the rest on peg 0
  const two = applyMove(one, 1, 2, n, 3);          // disk 1 onto the empty peg 2
  ok(!canMove(two, 1, 1, n, 3), 'a larger disk may not rest on a smaller one');
  ok(canMove(two, 0, 2, n, 3), 'a smaller disk may rest on anything');
  deepEq([...decode(two, 4, 3)], [1, 2, 0, 0], 'two moves in, the tower looks like this');
  eq(canMove(two, 1, 0, n, 3), true, 'disk 1 back onto the bare peg 0 is fine');
}

section('game: legalMoves enumerates, applyMove never invents');
{
  const n = 3;
  let bad = 0;
  let states = 0;
  for (let s = 0; s < 3 ** n; s++) {
    states++;
    for (const mv of legalMoves(s, n, 3)) {
      if (!canMove(s, mv.disk, mv.to, n, 3)) bad++;
      const after = applyMove(s, mv.disk, mv.to, n, 3);
      if (pegOf(after, mv.disk, 3) !== mv.to) bad++;
      if (decode(after, n, 3).filter((p, d) => p !== decode(s, n, 3)[d]).length !== 1) bad++;
    }
  }
  eq(states, 27, 'every position of the n=3 graph inspected');
  eq(bad, 0, 'legalMoves never proposes an illegal move; applyMove moves exactly one disk');
}

section('game: createGame and the counters');
{
  const lv = canonicalLevel(3, 4, 'lot-3p-4');
  const g = createGame(lv);
  eq(g.moves, 0, 'a fresh board has billed nothing');
  eq(g.par, 15, 'the par came from the baked measurement');
  eq(g.refused, 0, 'no refusals yet');
  eq(g.done, false, 'and it is not finished');
  eq(remaining(g), 15, 'moves left on the opening position');
  eq(isExact(g), true, 'a three-peg board knows its distance exactly');
  throws(() => createGame({ n: 3 }), 'createGame rejects a level without a shape');
  throws(() => createGame(null), '…and rejects nothing at all');
}

section('game: an illegal move is refused and NOT billed');
{
  const g = createGame(canonicalLevel(3, 4, 'lot-3p-4'));
  const before = { state: g.state, moves: g.moves, history: g.history.length };
  eq(move(g, 3, 1), false, 'lifting a buried disk is refused');
  eq(move(g, 0, 0), false, 'a peg onto itself is refused');
  eq(move(g, 0, 9), false, 'a peg that does not exist is refused');
  eq(moveTop(g, 0, 0), false, 'the gesture layer refuses the same things');
  eq(moveTop(g, -1, 0), false, 'including off-board sources');
  eq(moveTop(g, 0, 4), false, 'and off-board targets');
  eq(moveTop(g, 1, 0), false, 'an empty peg has nothing to lift');
  eq(moveTop(g, 0.5, 0), false, 'a non-integer peg index is not a move');
  eq(g.state, before.state, 'the position did not change');
  eq(g.moves, before.moves, 'the step counter did not change');
  eq(g.history.length, before.history, 'nothing entered the history');
  // Six of those refusals reach the rule (buried disk, self-move, off-board peg, same move
  // twice through moveTop, empty source); the two out-of-range peg indices are rejected by the
  // gesture guard before the rule is consulted, so they are not billed and not counted.
  eq(g.refused, 5, 'refusals that reached the rule were counted for the panel and the tests');
  ok(move(g, 0, 1), 'a legal move still works after eight refusals');
  eq(g.moves, 1, 'and exactly one move was billed');
}

section('game: steps only ever go up while playing, and undo is the only way back');
{
  const g = createGame(canonicalLevel(4, 4, 'lot-4p-4'));
  let last = g.moves;
  let dips = 0;
  for (let i = 0; i < 60; i++) {
    const mv = legalMoves(g.state, g.n, g.pegs)[i % 2];
    move(g, mv.disk, mv.to);
    if (g.moves < last) dips++;
    last = g.moves;
  }
  eq(dips, 0, 'a billed move is the only thing that changes the counter, and it goes up');
  ok(g.moves === 60 || g.done, 'sixty legal attempts, all billed unless the tower finished first');
  const snapshot = g.state;
  const n = g.moves;
  const parBefore = g.par;
  const leftBefore = remaining(g);
  ok(undo(g), 'undo reports it did something');
  eq(g.par, parBefore, 'undo never changes the printed bound');
  eq(remaining(g), leftBefore, 'and the distance left returns to what that position was worth');
  eq(g.moves, n - 1, 'undo takes the charge back');
  ok(g.state !== snapshot, 'the position went back too');
  while (undo(g)) { /* drain */ }
  eq(g.moves, 0, 'draining the history lands on the opening position');
  eq(g.state, g.start, 'exactly the start');
  eq(remaining(g), g.par, 'back at the start the distance left equals the bound again');
  eq(undo(g), false, 'and undoing past the start is a no, not a negative counter');
  reset(g);
  eq(g.state, g.start, 'reset restores the start');
  eq(g.moves, 0, 'reset zeroes the counter');
  eq(g.history.length, 0, 'reset clears the history');
}

section('game: playing the hint to the end produces the certified solution');
// The strongest single check in this file: the hint function, the rule and the grader are walked
// together, disk by disk, on every band's shape — and the length must equal the par bake measured
// by exhausting the whole graph.
for (const [pegs, n] of [[3, 3], [3, 7], [3, 13], [4, 5], [4, 8], [4, 10]]) {
  const g = createGame(canonicalLevel(pegs, n, `lot-${pegs}p-${n}`));
  let guard = 0;
  let illegal = 0;
  while (!g.done && guard < 20000) {
    const mv = hint(g);
    if (!mv) break;
    if (!canMove(g.state, mv.disk, mv.to, g.n, g.pegs)) illegal++;
    moveTop(g, mv.from, mv.to);
    guard++;
  }
  eq(g.done, true, `${pegs} pegs / ${n} disks: the tower finishes`);
  eq(illegal, 0, `${pegs} pegs / ${n} disks: every hint was legal`);
  eq(g.moves, g.par, `${pegs} pegs / ${n} disks: played in exactly the measured par (${g.par})`);
  eq(grade(g).key, 'certified', `${pegs} pegs / ${n} disks: graded 认证解`);
  eq(overPar(g), 0, `${pegs} pegs / ${n} disks: nothing over par`);
  eq(nextMove(g), null, `${pegs} pegs / ${n} disks: no hint once solved`);
  eq(move(g, SMALLEST, 1), false, `${pegs} pegs / ${n} disks: a finished board accepts no more moves`);
}

section('game: finishing above par is a win, but not a certified one');
// Two wasted round trips of the smallest disk cost exactly 2 moves and cannot break legality, so
// the graded outcome here is derived by hand rather than copied from a run: par 7, played 9 →
// 顺手塔成 (2 stars); played 13 → 历尽重塔 (1 star).
{
  const finishByHint = (g) => {
    let guard = 0;
    while (!g.done && guard++ < 500) {
      const mv = hint(g);
      if (!mv) break;
      moveTop(g, mv.from, mv.to);
    }
    return g;
  };
  const waste = (g, pairs) => {
    for (let i = 0; i < pairs; i++) {
      ok(moveTop(g, 0, 1), `waste hop ${i + 1}a is legal`);
      ok(moveTop(g, 1, 0), `waste hop ${i + 1}b is legal`);
    }
    eq(g.state, g.start, 'a wasted round trip returns the position to where it began');
  };
  const clean = finishByHint(createGame(canonicalLevel(3, 3, 'lot-3p-3')));
  eq(clean.par, 7, 'n=3 par is 7');
  eq(clean.moves, 7, 'hint-played with no waste lands on par');
  eq(grade(clean).key, 'certified', 'that is the certified solution');
  eq(grade(clean).stars, 3, 'three stars for matching the proven bound');
  const twoOver = createGame(canonicalLevel(3, 3, 'lot-3p-3'));
  waste(twoOver, 1);
  finishByHint(twoOver);
  eq(twoOver.moves, 9, 'one wasted round trip costs two moves');
  eq(overPar(twoOver), 2, '…and the panel says 超 2');
  eq(grade(twoOver).key, 'clean', '已通关，但未达已证下界 — graded, not certified');
  eq(grade(twoOver).stars, 2, 'two stars');
  const fiveOver = createGame(canonicalLevel(3, 3, 'lot-3p-3'));
  waste(fiveOver, 2);
  finishByHint(fiveOver);
  eq(fiveOver.moves, 11, 'two wasted round trips cost four moves');
  eq(grade(fiveOver).key, 'long', 'over by four drops to the lowest grade');
  eq(grade(fiveOver).stars, 1, 'one star');
  eq(remaining(twoOver), 0, 'a finished board has nothing left to do');
  eq(twoOver.done, true, 'and says so');
}

section('game: scrambled boards carry a measured par too, and stay solvable');
{
  const lv = makeLevel('probe|daily', 'linked');
  eq(lv.kind, 'scramble', 'the generator produced a scrambled board');
  ok(lv.par >= lv.band[0] && lv.par <= lv.band[1], `measured par ${lv.par} sits inside its band ${JSON.stringify(lv.band)}`);
  ok(lv.par < lv.closedForm, `a scramble is shorter than the full tower (${lv.par} < ${lv.closedForm})`);
  const g = createGame(lv);
  ok(!g.done, 'it does not start finished');
  let guard = 0;
  let missingHint = 0;
  while (!g.done && guard++ < 500) {
    const mv = hint(g);
    if (!mv) { missingHint++; break; }
    moveTop(g, mv.from, mv.to);
  }
  eq(missingHint, 0, 'a three-peg scramble always has a hint');
  eq(g.moves, lv.par, `played to the goal in exactly the measured ${lv.par} moves`);
  const d = createGame(dailyLevel('2026-09-27'));
  eq(d.kind, undefined, 'a game carries no kind field — the row does');
  ok(d.par > 0 && Number.isSafeInteger(d.par), `the daily board's par is the measured distance (${d.par})`);
  eq(remaining(d), d.par, '…and the distance left starts equal to it');
  eq(makeLevel('probe|daily', 'linked').start, lv.start, 'the same seed regenerates the same board');
  eq(dailyLevel('2026-09-27').start, d.start, 'the same date regenerates the same board');
  ok(dailyLevel('2026-09-28').start !== d.start || dailyLevel('2026-09-28').n !== d.n, 'a different date is a different board');
}

section('game: the four-peg big board refuses to invent a live distance');
{
  const g = createGame(canonicalLevel(4, 10, 'lot-4p-10'));
  eq(isExact(g), false, 'this board is not measured at click time');
  eq(remaining(g), 49, 'while on the certified route the distance is known exactly');
  const mv = hint(g);
  eq(describeMove({ disk: 2, from: 0, to: 3 }), '第 3 号盘 A → D', 'moves are described in the words the panel shows');
  eq(describeMove({ disk: 0, from: 1, to: 2 }, ['甲', '乙', '丙']), '第 1 号盘 乙 → 丙', '…with the peg names the shell passes in');
  moveTop(g, mv.from, mv.to);
  const off = legalMoves(g.state, g.n, g.pegs).find((x) => !(x.disk === hint(g)?.disk && x.to === hint(g)?.to));
  ok(!!off, 'there is a legal move that is not the certified one');
  ok(moveTop(g, off.from, off.to), 'the off-route move is billed normally');
  eq(remaining(g), null, 'leaving the route makes the remaining counter an unknown, not a guess');
  eq(overPar(g), Math.max(0, g.moves - g.par), 'over par still degrades gracefully to billed minus par');
}

section('game: js/core stays pure (guarded storage excepted)');
{
  const dir = join(fileURLToPath(new URL('../js/core', import.meta.url)), '');
  const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
  eq(files.includes('storage.js'), true, 'storage.js is the one documented exception');
  let touched = [];
  for (const f of files) {
    if (f === 'storage.js') continue;
    const src = readFileSync(join(dir, f), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (/\b(window|document|localStorage|navigator|requestAnimationFrame|fetch)\b/.test(code)) touched.push(f);
  }
  deepEq(touched, [], 'no core file other than storage.js names a browser global');
}

const c = run();
process.exit(c.fails ? 1 : 0);
