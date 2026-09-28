// The save file. Every path here is exercised against a fake `window.localStorage` installed on
// globalThis — including one that throws on every call, because that is what Safari private mode
// and some embedded webviews actually do, and the game must keep playing.

import { ok, eq, deepEq, notThrows, run, section } from '../tools/harness.mjs';
import {
  SAVE_VERSION, STORAGE_KEY, bestOf, doneList, dailyDone, levelKey, load, markDaily, normalize,
  persist, recordResult, reset, save, selfTest, stats, store, unlockedIds,
} from '../js/core/storage.js';

function fakeStorage({ throwOnWrite = false, throwOnRead = false, throwOnRemove = false } = {}) {
  const map = new Map();
  return {
    map,
    getItem(k) {
      if (throwOnRead) throw new Error('SecurityError: read blocked');
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throwOnWrite) throw new Error('QuotaExceededError: write blocked');
      map.set(k, String(v));
    },
    removeItem(k) {
      if (throwOnRemove) throw new Error('SecurityError: remove blocked');
      map.delete(k);
    },
  };
}

const install = (opts) => {
  const s = fakeStorage(opts);
  globalThis.window = { localStorage: s };
  return s;
};

section('storage: no browser, no problem');
{
  delete globalThis.window;
  eq(store(), null, 'with no window at all, store() is null rather than an exception');
  deepEq(load(), { v: SAVE_VERSION, best: {}, daily: {}, unlocked: [], stats: { plays: 0, wins: 0, certified: 0, moves: 0 }, updatedAt: 0 }, 'load() hands back a default save');
  eq(save(load()), false, 'and save() reports it could not persist');
  eq(reset(), false, 'reset on a machine with no storage says so');
  deepEq(selfTest(), { ok: false, reason: 'unavailable' }, 'selfTest names the reason');
  eq(STORAGE_KEY, 'hanoi.save.v1', 'the key this repo owns — no other repo\'s key is touched');
  eq(SAVE_VERSION, 1, 'version 1');
}

section('storage: a throwing localStorage is swallowed everywhere');
{
  install({ throwOnWrite: true, throwOnRead: true });
  eq(store(), null, 'a store that throws on the probe write is treated as absent');
  notThrows(() => load(), 'load() does not throw');
  notThrows(() => save({ v: 1, best: { 'lot-3p-4': 15 } }), 'save() does not throw');
  notThrows(() => recordResult({ id: 'lot-3p-4' }, { moves: 15, win: true, certified: true }), 'recording a win does not throw');
  notThrows(() => markDaily('2026-09-27', 7), 'nor does marking the daily');
  notThrows(() => reset(), 'nor does reset');
  deepEq(load().best, {}, 'and the game is left with a clean default board book');
  eq(save(load()), false, 'writes say false, so the shell can print 仅本次会话');
}

section('storage: garbage on disk falls back, and the next write overwrites it');
{
  const s = install();
  s.map.set(STORAGE_KEY, '{ not json');
  deepEq(load().best, {}, 'a truncated file reads as a default save');
  s.map.set(STORAGE_KEY, 'null');
  deepEq(load().best, {}, 'a null document too');
  s.map.set(STORAGE_KEY, '"a string"');
  eq(load().v, SAVE_VERSION, 'a bare string is not a save either');
  s.map.set(STORAGE_KEY, JSON.stringify({ v: 1, best: { 'lot-3p-4': -7, 'lot-3p-5': 31.5, 'lot-3p-6': '15', 'lot-3p-7': 127 }, daily: 'nope', unlocked: 'ABC', stats: null }));
  const bad = load();
  deepEq(bad.best, { 'lot-3p-7': 127 }, 'negatives, fractions and strings are dropped; only a real integer survives');
  deepEq(bad.daily, {}, 'a string where a map belongs becomes an empty map');
  deepEq(bad.unlocked, [], 'a string where a list belongs becomes an empty list');
  deepEq(bad.stats, { plays: 0, wins: 0, certified: 0, moves: 0 }, 'missing counters read as zero, never undefined');
  ok(save(bad), 'the corrupted key is writable again');
  eq(JSON.parse(s.map.get(STORAGE_KEY)).best['lot-3p-7'], 127, 'and the sanitised shape is what landed on disk');
  ok(!('lot-3p-4' in JSON.parse(s.map.get(STORAGE_KEY)).best), 'the negative record did not get re-blessed by the round trip');
}

section('storage: a future version is not misread as this one');
{
  const s = install();
  s.map.set(STORAGE_KEY, JSON.stringify({ v: 99, best: { 'lot-3p-9': 511 }, daily: {}, unlocked: [], stats: { plays: 4 }, updatedAt: 1 }));
  const back = load();
  eq(back.v, SAVE_VERSION, 'the version stamp is rewritten to what this build understands');
  deepEq(back.stats, { plays: 4, wins: 0, certified: 0, moves: 0 }, 'readable counters are kept, missing ones zeroed');
}

section('storage: best only goes down, unlocks only go up');
{
  install();
  const lv = { id: 'lot-3p-4', n: 4, pegs: 3 };
  ok(recordResult(lv, { moves: 20, win: true, certified: false }).ok, 'the first finish is recorded');
  eq(bestOf('lot-3p-4'), 20, 'a win writes the record');
  recordResult(lv, { moves: 25, win: true, certified: false });
  eq(bestOf('lot-3p-4'), 20, 'a worse finish never overwrites it');
  recordResult(lv, { moves: 15, win: true, certified: true });
  eq(bestOf('lot-3p-4'), 15, 'a better one does');
  recordResult(lv, { moves: 99, win: false, certified: false });
  eq(bestOf('lot-3p-4'), 15, 'an unfinished board cannot change a record');
  recordResult(lv, { moves: -3, win: true, certified: true });
  eq(bestOf('lot-3p-4'), 15, 'and neither can a nonsense negative one');
  recordResult(lv, { moves: 15, win: false, certified: false }); // a sixth visit, unfinished
  const st = stats();
  // Six calls, one level: 20w, 25w, 15wc, 99lose, -3 (nothing billed), 15lose — tallled by hand
  // against the documented contract, not by reading the code back.
  deepEq([st.plays, st.wins, st.certified, st.moves, st.records], [6, 4, 2, 174, 1], 'counters: six boards played, four finished, two certified, 174 steps billed, one record held');
  eq(doneList().join(','), 'lot-3p-4', 'the record book lists what has been done');
  eq(unlockedIds().length, 1, 'all six visits share one level key, so the unlock list holds one entry');
  eq(unlockedIds().filter((x) => x === 'lot-3p-4').length, 1, 'visiting twice does not duplicate the unlock');
  deepEq([levelKey(lv), levelKey({ pegs: 3, n: 4, start: 0 })], ['lot-3p-4', 'b3-4-0'], 'rows without an id are keyed by their position');
}

section('storage: dailies are keyed by date');
{
  install();
  eq(dailyDone('2026-09-27'), null, 'an untouched day has no record');
  markDaily('2026-09-27', 15);
  eq(dailyDone('2026-09-27'), 15, 'the day is marked with the steps it took');
  markDaily('2026-09-27', 11);
  eq(dailyDone('2026-09-27'), 11, 'a better run improves it');
  markDaily('2026-09-27', 40);
  eq(dailyDone('2026-09-27'), 11, 'a worse one leaves it alone');
  markDaily('2026-09-28', 6);
  deepEq(Object.keys(load().daily).sort(), ['2026-09-27', '2026-09-28'], 'each day keeps its own line');
  eq(stats().dailies, 2, 'and the stats strip counts them');
}

section('storage: reset really resets');
{
  const s = install();
  recordResult({ id: 'lot-3p-5' }, { moves: 31, win: true, certified: true });
  markDaily('2026-09-27', 9);
  ok(s.map.has(STORAGE_KEY), 'there is a save on disk');
  ok(reset(), 'reset succeeds');
  ok(!s.map.has(STORAGE_KEY), 'the key is gone, not merely emptied');
  deepEq(load(), normalize(null), 'and a fresh load is byte-for-byte a first visit');
  eq(bestOf('lot-3p-5'), null, 'no records survive');
  eq(unlockedIds().length, 0, 'no unlocks survive');
}

section('storage: persist() is the only mutator, and it round-trips');
{
  install();
  const { ok: wrote, data } = persist((d) => { d.best['lot-3p-6'] = 63; });
  eq(wrote, true, 'the write reported success');
  eq(load().best['lot-3p-6'], 63, 'it is readable afterwards');
  eq(data.updatedAt > 0, true, 'the save is stamped');
  ok(Number.isFinite(Number(load().updatedAt)), 'updatedAt survives JSON as a number');
  const failed = install({ throwOnWrite: true });
  const { ok: wrote2 } = persist((d) => { d.best['lot-3p-6'] = 62; });
  eq(wrote2, false, 'with a blocked disk the mutation still runs in memory…');
  eq(load().best['lot-3p-6'], undefined, '…but nothing pretends to have been kept');
  ok(failed, 'the fake store was installed');
}

const c = run();
process.exit(c.fails ? 1 : 0);
