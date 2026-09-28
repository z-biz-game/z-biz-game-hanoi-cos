// Every expectation in this file was typed by hand from an independent re-implementation of
// FNV-1a written straight from the definition with BigInt arithmetic (no Math.imul, no shared
// code path with js/core/rng.js). If rng.js changes behaviour, these numbers stop matching —
// which is the point.

import { ok, eq, deepEq, run, section } from '../tools/harness.mjs';
import { hashSeed, mulberry32, rngFrom, todayKey } from '../js/core/rng.js';

section('rng: FNV-1a vectors (independent BigInt implementation)');

// offset basis, and the two-bytes-per-code-unit mixing that makes this differ from the published
// byte-wise FNV vectors.
eq(hashSeed(''), 2166136261, 'hashSeed("") is the FNV offset basis');
eq(hashSeed('a'), 723832900, 'hashSeed("a")');
eq(hashSeed('hanoi'), 1339179780, 'hashSeed("hanoi")');
eq(hashSeed('lot-3p-4'), 2660766453, 'hashSeed("lot-3p-4")');
eq(hashSeed('random|42'), 3021100564, 'hashSeed("random|42")');
eq(hashSeed('daily|2026-09-27'), 2210448354, 'hashSeed("daily|2026-09-27")');

section('rng: non-ASCII seeds exercise the second byte of each code unit');
eq(hashSeed('汉诺塔'), 1593132435, 'hashSeed("汉诺塔") mixes the high byte too');
eq(hashSeed('汉诺塔') === hashSeed('塔诺汉'), false, 'a permutation of the same characters is a different seed');

section('rng: mulberry32 vectors');
const a = mulberry32(hashSeed('hanoi'));
deepEq([a(), a(), a(), a()].map((x) => x.toFixed(12)), ['0.448956630426', '0.025155034149', '0.217716222862', '0.359852642752'], 'mulberry32(hashSeed("hanoi")) first four draws');
const b = mulberry32(hashSeed('daily|2026-09-27'));
deepEq([b(), b(), b(), b()].map((x) => x.toFixed(12)), ['0.356757473666', '0.661422130885', '0.894574948819', '0.864408084424'], 'mulberry32(hashSeed("daily|2026-09-27")) first four draws');
ok([...Array(200)].every(() => {
  const r = mulberry32(123456789)();
  return r >= 0 && r < 1;
}), 'every draw is in [0,1)');

section('rng: helpers are deterministic');
const c = rngFrom('rng-vectors');
deepEq([c.range(1, 6), c.range(1, 6), c.range(1, 6), c.range(1, 6), c.range(1, 6), c.range(1, 6)], [2, 5, 3, 6, 6, 6], 'range(1,6) six times');
const d = rngFrom('shuffle');
const arr = [0, 1, 2, 3, 4, 5, 6, 7];
eq(d.shuffle(arr).join(','), '3,7,1,4,0,2,5,6', 'shuffle is a permutation and a function of the seed');
eq(rngFrom('same').int(1000), rngFrom('same').int(1000), 'two fresh readers of one seed agree');
eq(rngFrom(42)().toFixed(12), mulberry32(42)().toFixed(12), 'a numeric seed is used directly');
const reused = rngFrom('reuse');
ok(rngFrom(reused) === reused, 'an rng passes through rngFrom unchanged');

section('rng: todayKey is the local calendar date');
eq(todayKey(new Date(2026, 8, 27)), '2026-09-27', 'September is month 08 → "09", zero padded');
eq(todayKey(new Date(2026, 0, 5)), '2026-01-05', 'single-digit day padded');
eq(typeof todayKey(), 'string', 'today with no argument still yields a string');

const c2 = run();
process.exit(c2.fails ? 1 : 0);
