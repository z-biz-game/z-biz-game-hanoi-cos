// The only core file allowed to touch the browser at all, and even here it is guarded: every
// localStorage call sits in a try/catch, because Safari's private-bond mode and some embedded
// webviews make `setItem` THROW rather than return false. Nothing else in js/core/ reads
// window, document or localStorage; tools/../test/storage.test.mjs asserts that with a stub that
// explodes on the first write.
//
// Save format (versioned, so a future change can migrate instead of silently mis-reading):
//   { v: 1, best: { "lot-3p-4": 15 }, done: { ... }, daily: { "2026-09-27": 7 },
//     stats: { plays, wins, certified, moves, seconds }, updatedAt }

export const STORAGE_KEY = 'hanoi.save.v1';
export const SAVE_VERSION = 1;

const EMPTY = () => ({
  v: SAVE_VERSION,
  best: {},
  daily: {},
  unlocked: [],
  stats: { plays: 0, wins: 0, certified: 0, moves: 0 },
  updatedAt: 0,
});

// Returns the backing store, or null when there is none / it throws. Kept as a function (not a
// const) so a test can swap window.localStorage in after load.
export function store() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const probe = '__hanoi_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch (e) {
    return null; // private mode / disabled cookies / quota: the game runs, it just forgets
  }
}

function ints(raw) {
  // Only non-negative safe integers survive. A hand-edited -7 in best would otherwise print as
  // "steps used -7" and out-par the level.
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    const v = raw[k];
    if (Number.isSafeInteger(v) && v >= 0) out[k] = v;
  }
  return out;
}

export function normalize(data) {
  const base = EMPTY();
  if (!data || typeof data !== 'object') return base;
  const stats = data.stats && typeof data.stats === 'object' ? data.stats : {};
  const num = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
  return {
    v: SAVE_VERSION,
    best: ints(data.best),
    daily: ints(data.daily),
    unlocked: Array.isArray(data.unlocked) ? data.unlocked.filter((x) => typeof x === 'string') : [],
    stats: {
      plays: num(stats.plays),
      wins: num(stats.wins),
      certified: num(stats.certified),
      moves: num(stats.moves),
    },
    updatedAt: num(data.updatedAt),
  };
}

// Never throws: a missing key, a truncated JSON string or garbage from an older build all come
// back as the default save.
export function load() {
  const s = store();
  if (!s) return EMPTY();
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return EMPTY();
    return normalize(JSON.parse(raw));
  } catch (e) {
    return EMPTY();
  }
}

// Returns true only when the bytes really landed, so main.js can say "已保存" vs "仅本次会话".
export function save(data) {
  const s = store();
  if (!s) return false;
  try {
    const clean = normalize(data);
    clean.updatedAt = Date.now();
    s.setItem(STORAGE_KEY, JSON.stringify(clean));
    return true;
  } catch (e) {
    return false; // quota exceeded: keep playing in memory
  }
}

// Read-modify-write, and the `data` handed back is what the disk now holds (re-read, so the
// timestamp and any sanitising `save` did are visible to the caller).
export function persist(mutate) {
  const data = load();
  mutate(data);
  const ok = save(data);
  return { data: load(), ok };
}

// A level gets a `key` so the same LOT reached by another door (campaign vs random with an
// identical board) still has one record. Rows without an id fall back to their board encoding.
export function levelKey(level) {
  if (level && level.id) return String(level.id);
  return `b${level ? level.pegs : '?'}-${level ? level.n : '?'}-${level ? level.start : '?'}`;
}

// One write per finished board: plays/wins/certified count up, best only ever moves down, and the
// level lands in `unlocked` so the campaign can show progress.
export function recordResult(level, { moves, win, certified }) {
  const key = levelKey(level);
  const billed = Number.isSafeInteger(moves) && moves >= 0 ? moves : 0;
  return persist((data) => {
    data.stats.plays += 1;
    data.stats.moves += billed;
    if (win) data.stats.wins += 1;
    if (certified) data.stats.certified += 1;
    if (win && billed > 0) {
      const prev = data.best[key];
      if (prev === undefined || billed < prev) data.best[key] = billed;
    }
    if (!data.unlocked.includes(key)) data.unlocked.push(key);
  });
}

export function bestOf(id, data = load()) {
  const v = data.best[String(id)];
  return Number.isSafeInteger(v) ? v : null;
}

export function doneList(data = load()) {
  return Object.keys(data.best).sort();
}

export function unlockedIds(data = load()) {
  return data.unlocked.slice();
}

// Daily records are keyed by the calendar date, so "same puzzle worldwide" needs no server: the
// board itself is derived from the date in make.js, only the score is stored.
export function dailyDone(dateKey, data = load()) {
  const v = data.daily[String(dateKey)];
  return Number.isSafeInteger(v) ? v : null;
}

export function markDaily(dateKey, moves) {
  return persist((data) => {
    const prev = data.daily[dateKey];
    if (prev === undefined || (Number.isSafeInteger(moves) && moves < prev)) {
      data.daily[dateKey] = Number.isSafeInteger(moves) ? moves : 0;
    }
  });
}

export function stats(data = load()) {
  return { ...data.stats, records: Object.keys(data.best).length, dailies: Object.keys(data.daily).length };
}

// "Reset" must really reset: the key is removed, not just overwritten, so a later load() sees the
// same shape as a first visit.
export function reset() {
  const s = store();
  if (!s) return false;
  try {
    s.removeItem(STORAGE_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

// The self-check main.js can surface: does writing work here, and does the shape survive a read?
export function selfTest() {
  const s = store();
  if (!s) return { ok: false, reason: 'unavailable' };
  try {
    const bak = s.getItem(STORAGE_KEY);
    s.setItem(STORAGE_KEY + '.probe', JSON.stringify(EMPTY()));
    const back = JSON.parse(s.getItem(STORAGE_KEY + '.probe'));
    s.removeItem(STORAGE_KEY + '.probe');
    if (bak === null) s.removeItem(STORAGE_KEY);
    else s.setItem(STORAGE_KEY, bak);
    return { ok: !!back && back.v === SAVE_VERSION, reason: 'ok' };
  } catch (e) {
    return { ok: false, reason: e && e.name ? e.name : String(e) };
  }
}

export default { STORAGE_KEY, SAVE_VERSION, store, load, save, reset, stats, selfTest };
