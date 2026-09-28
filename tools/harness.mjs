// Shared assertion harness. Both test/blocks/*.test.mjs (node) and tools/playtest.mjs (browser,
// via an inline copy) print the same two-line contract:
//
//   rows: 57 fail: 0
//
// so verify.sh can grep one pattern for every layer. Nothing here imports window, so the file is
// usable from node directly.

let rows = 0;
let fails = 0;
const problems = [];

export function ok(cond, label) {
  rows++;
  if (cond) return true;
  fails++;
  problems.push(label);
  console.log(`  FAIL  ${label}`);
  return false;
}

export function eq(actual, expected, label) {
  const same = Object.is(actual, expected)
    || (typeof actual === 'number' && typeof expected === 'number' && Number.isNaN(actual) && Number.isNaN(expected));
  rows++;
  if (same) return true;
  fails++;
  problems.push(label);
  console.log(`  FAIL  ${label}\n        expected: ${format(expected)}\n        actual:   ${format(actual)}`);
  return false;
}

export function deepEq(actual, expected, label) {
  return eq(JSON.stringify(actual), JSON.stringify(expected), label);
}

export function throws(fn, label) {
  rows++;
  try {
    fn();
  } catch (e) {
    return true;
  }
  fails++;
  problems.push(label);
  console.log(`  FAIL  ${label}  (expected a throw, got none)`);
  return false;
}

export function notThrows(fn, label) {
  rows++;
  try {
    fn();
    return true;
  } catch (e) {
    fails++;
    problems.push(label);
    console.log(`  FAIL  ${label}  (threw ${e && e.message})`);
    return false;
  }
}

function format(v) {
  if (Array.isArray(v)) return `[${v.length}] ${JSON.stringify(v.slice(0, 16))}${v.length > 16 ? ' …' : ''}`;
  if (typeof v === 'object' && v !== null) return JSON.stringify(v).slice(0, 200);
  return String(v);
}

export function counters() {
  return { rows, fails, problems };
}

export function reset() {
  rows = 0;
  fails = 0;
  problems.length = 0;
}

// Sections keep the output readable; every layer prints them the same way.
export function section(title) {
  console.log(`\n== ${title}`);
}

export function run() {
  const c = counters();
  console.log(`\nrows: ${c.rows} fail: ${c.fails}`);
  if (c.fails) {
    console.log('failed asserts:');
    for (const p of c.problems) console.log(`  - ${p}`);
  }
  return c;
}
