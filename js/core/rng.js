// Deterministic RNG. Every puzzle in this repo is a pure function of a seed string, so a
// daily board and a shared `#/lot/<id>` / `#/random/...` link resolve to the same tower on
// any device — no account, no network, nothing carried between devices.
//
// FNV-1a (32-bit, two bytes per code unit, which is what makes it differ from the published
// byte-wise test vectors: every character is mixed in twice) feeding mulberry32. The pairing
// is copied verbatim from the sibling repos in this family so a seed string means the same
// thing in all of them.
//
// The literal expectations for this file are hand-typed in test/rng.test.mjs, where they are
// checked against a second, independent implementation written straight from the FNV
// definition (BigInt arithmetic, no `Math.imul`), so a change here is caught rather than
// quietly re-blessed.

export function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193);
    h ^= (str.charCodeAt(i) >> 8) & 0xff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(a) {
  let s = a >>> 0;
  const rng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  return rng;
}

export function rngFrom(seed) {
  if (typeof seed === 'function' && seed.int) return seed;
  if (typeof seed === 'number') return mulberry32(seed >>> 0);
  return mulberry32(hashSeed(String(seed)));
}

// The daily key: local calendar date, zero padded, `YYYY-MM-DD`.
export function todayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
