// Does everything the page names actually sit in the tree it ships from?
//
// The git tree always passes this question — the files are committed. The GitHub Pages artifact is
// a *copy list* (`.github/workflows/pages.yml`), and a list that forgets `assets/` ships a page
// whose manifest, service worker, every icon and the og card are 404s while the repo looks intact.
// That is the class of bug only an artifact-rooted check can see, so this tool takes a root as its
// argument: `node tools/ship_check.mjs` asks the working tree, CI asks `_site`.
//
// Declared paths are read from where they are actually declared, not from a list kept here:
//   index.html        href= / src= / og:image content=
//   manifest.webmanifest  icons[].src (+ any `sizes` it claims), start_url, shortcuts[].url
//   css/*.css, js/**/*.js  string literals that look like an asset path
// A PNG is checked against its own IHDR, and a declared `NxN` size has to match the real pixels.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.dirname(path.dirname(fileURLToPath(import.meta.url))));

const declared = new Map(); // relPath -> Set(where)
const note = (raw, where) => {
  if (!raw) return;
  let p = String(raw).trim();
  if (!p || p.startsWith('data:') || p.startsWith('http:') || p.startsWith('https:')
    || p.startsWith('//') || p.startsWith('#') || p.startsWith('mailto:')) return;
  p = p.replace(/^.\//, '').split('#')[0].split('?')[0];
  if (!p) return;
  if (!declared.has(p)) declared.set(p, new Set());
  declared.get(p).add(where);
};

const walk = (dir, out = []) => {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

// ---- index.html ------------------------------------------------------------------------------
const htmlPath = path.join(ROOT, 'index.html');
const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
if (!html) {
  console.log(`no index.html under ${ROOT} — nothing to check`);
  process.exit(2);
}
for (const m of html.matchAll(/<\w[^>]*?\b(href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) note(m[2], 'index.html');
for (const m of html.matchAll(/<meta[^>]*property\s*=\s*["']og:image["'][^>]*content\s*=\s*["']([^"']+)["']/gi)) note(m[1], 'og:image');
for (const m of html.matchAll(/<meta[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:image["']/gi)) note(m[1], 'og:image');

// ---- manifest.webmanifest --------------------------------------------------------------------
const manPath = path.join(ROOT, 'manifest.webmanifest');
const sizeClaims = new Map(); // relPath -> [w,h] claimed by `sizes`
const manPathInRoot = fs.existsSync(manPath) ? manPath : path.join(ROOT, 'manifest.webmanifest');
if (fs.existsSync(manPathInRoot)) {
  let man = null;
  try { man = JSON.parse(fs.readFileSync(manPathInRoot, 'utf8')); } catch (e) { console.log(`manifest parse: ${e.message}`); }
  if (man) {
    for (const ic of man.icons || []) {
      note(ic.src, 'manifest:icons');
      const d = /(\d+)\s*x\s*(\d+)/.exec(ic.sizes || '');
      if (d && ic.src) {
        const key = String(ic.src).replace(/^\.\//, '');
        if (!sizeClaims.has(key)) sizeClaims.set(key, []);
        sizeClaims.get(key).push([Number(d[1]), Number(d[2])]);
      }
    }
    for (const sc of man.screenshots || []) note(sc.src, 'manifest:screenshots');
    for (const sh of man.shortcuts || []) note(sh.url, 'manifest:shortcuts');
    note(man.start_url, 'manifest:start_url');
  }
} else {
  console.log('MISSING manifest.webmanifest (declared by index.html as <link rel="manifest">)');
}

// ---- asset paths named in css / js ----------------------------------------------------------
const ASSET_RE = /["'`]((?:assets|icons|art)\/[^"'`\s]+\.(?:png|jpg|jpeg|webp|svg|gif|ico))["'`]/g;
// The service worker is named by no HTML attribute at all: js/pwa.js hands it to
// `register('./sw.js')`. An artifact without that file installs nothing and says so only in the
// console, which is exactly the failure this whole tool exists to catch.
const SW_RE = /\bregister\(\s*['"]([^'"]+)['"]/g;
for (const f of walk(path.join(ROOT, 'css')).concat(walk(path.join(ROOT, 'js')))) {
  if (!/\.(css|js)$/.test(f)) continue;
  const text = fs.readFileSync(f, 'utf8');
  for (const m of text.matchAll(ASSET_RE)) note(m[1], path.relative(ROOT, f));
  if (path.relative(ROOT, f).startsWith('js')) {
    for (const m of text.matchAll(SW_RE)) note(m[1], `${path.relative(ROOT, f)}:sw register`);
  }
}

// ---- PNG IHDR -------------------------------------------------------------------------------
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24) return { err: `short file (${b.length} bytes)` };
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return { err: 'not a PNG signature' };
  if (b.subarray(12, 16).toString('ascii') !== 'IHDR') return { err: 'no IHDR chunk' };
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

let missing = 0;
let bad = 0;
let bigIcon = 0;
const rows = [];
for (const [rel, wheres] of [...declared.entries()].sort()) {
  const file = path.join(ROOT, rel);
  const where = [...wheres].join(',');
  if (!fs.existsSync(file)) {
    rows.push(`MISSING  ${rel}  <- ${where}`);
    missing++;
    continue;
  }
  const st = fs.statSync(file);
  let line = `ok       ${rel}  (${st.size} B)  <- ${where}`;
  if (st.size === 0) {
    line = `EMPTY    ${rel}  0 bytes  <- ${where}`;
    bad++;
  } else if (/\.png$/i.test(rel)) {
    const d = pngSize(file);
    if (d.err) {
      line = `NOTPNG   ${rel}  ${d.err}  <- ${where}`;
      bad++;
    } else {
      const short = Math.min(d.w, d.h);
      if (short >= 180) bigIcon++;
      const claims = sizeClaims.get(rel) || [];
      const wrong = claims.filter(([w, h]) => w !== d.w || h !== d.h);
      line = `ok       ${rel}  (${d.w}x${d.h}, ${st.size} B)  <- ${where}`;
      if (wrong.length) {
        line = `SIZES    ${rel}  IHDR ${d.w}x${d.h} but manifest claims ${wrong.map(([w, h]) => `${w}x${h}`).join('/')}  <- ${where}`;
        bad++;
      }
    }
  }
  rows.push(line);
}

console.log(`ship_check root=${ROOT} declared=${declared.size}`);
for (const r of rows) console.log(`  ${r}`);
console.log(`missing=${missing} malformed=${bad} pngs_with_short_edge>=180=${bigIcon}`);
if (missing || bad) { console.log('FAIL 声明的路径没有全部真的在产物里'); process.exit(1); }
if (!bigIcon) { console.log('FAIL 没有一条 ≥180px 的真 PNG 图标（可装桌面口径）'); process.exit(1); }
console.log('PASS 每条声明的路径都在盘上，且是真图');
