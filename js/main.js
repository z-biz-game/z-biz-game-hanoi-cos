// The shell: hash router, DOM, save file, and the `window.hanoi` test hook. It owns no rule and
// no arithmetic — every number it prints comes from js/core (the baked table, the recursion or
// the exhaustive sweep), and every move it makes goes through game.js `moveTop`, the same door a
// finger on the canvas uses.
//
// Wording is contractual: 下界 = the proven minimum (par), 已用步数 = what was billed, 超 N 步 =
// the overage. A finish with steps === par is 认证解; steps > par is 已通关，但未达已证下界.

import {
  applyMove, createGame, decode, grade, hint, isExact, legalMoves, moveTop, nextMove, overPar,
  pegOf, pegStepOk, pegTops, remaining, reset as resetGame, undo,
} from './core/game.js';
import {
  BAKE, LOTS, bands, byId, campaign, dailyBand, dailyBoard, describe, firstRow, maxStates,
  randomLevel, rowList, stats as tableStats,
} from './core/library.js';
import { EXHAUST_LIMIT, TABLE_BUDGET, FS_RANGE, closedForm3, closedFormLine, fsPar, stateCount } from './core/solve.js';
import { bestOf, dailyDone, doneList, load as loadSave, markDaily, recordResult, reset as wipeSave, selfTest, stats as saveStats, unlockedIds } from './core/storage.js';
import { todayKey } from './core/rng.js';
// BANDS, not TIERS: TIERS is the four *free* difficulty bands the daily and random generators
// partition, and make.dailyLevel hashes a date into `hash % TIERS.length` — adding 线柱 there would
// silently re-band every date already played. BANDS is TIERS plus the appended 线柱 band, and it is
// what a route or a label has to be looked up in, or `#/random/line/…` falls back to shoal and the
// board mislabels itself.
import { BANDS } from './core/make.js';
import { createView } from './view.js';

const $ = (id) => document.getElementById(id);
const el = {};
for (const id of ['board', 'stage', 'lotId', 'band', 'shape', 'steps', 'left', 'over', 'par', 'space', 'ways', 'proof', 'best', 'unlocked', 'hintline', 'undo', 'hint', 'restart', 'demo', 'hintToggle', 'curtain', 'card', 'cardTitle', 'cardBody', 'cardNext', 'close', 'index', 'indexList', 'toast', 'reset', 'saveState', 'today', 'cap', 'counter', 'routeBox']) {
  el[id] = $(id);
}

const app = {
  mode: 'lot',
  level: null,
  game: null,
  hash: '',
  hints: 0,
  index: -1,
  toastTimer: 0,
  demoTimer: 0,
  wipeArmed: false,
  lastRecord: null,
};

const view = createView(el.board, {
  move: (m) => commit(m.from, m.to),
  // One ledger for both doors. js/core/game.js bills "an empty peg holds nothing to lift" as a
  // refusal in `moveTop`, but a press on an empty peg is answered by the view and never reaches
  // moveTop, so the shell books it here; the `(app.refused || 0) + 1` this replaced was a second
  // ledger that nothing ever read — state prints `g.refused`.
  //
  // The return value is the toast text: the view owns the gesture, the core owns the verdict, so
  // the words describing a rejection come from this file in both cases rather than from a guess
  // made in canvas code.
  refuse: (info) => {
    if (!app.game || !info) return null;
    app.game.refused++;
    return info.reason === 'nothing to lift'
      ? `${PEG_NAMES[info.peg]} 柱是空的，没有盘可拿`
      : refusalReason(info.from, info.to);
  },
  hint: () => (app.demoTimer ? null : nextMove(app.game)),
});

// Read from the canvas, not retyped: a toast and the board must never name the same peg apart.
const PEG_NAMES = view.PEG_NAMES;

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

// ---- routing --------------------------------------------------------------------------------
function parse(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return { mode: 'lot', id: 'lot-3p-4' };
  if (parts[0] === 'index') return { mode: 'index' };
  if (parts[0] === 'daily') return { mode: 'daily', date: parts[1] || todayKey() };
  if (parts[0] === 'random') {
    const band = BANDS.some((t) => t.key === parts[1]) ? parts[1] : 'shoal';
    const token = parts[2] || todayKey();
    return { mode: 'random', band, token };
  }
  if (parts[0] === 'campaign') return { mode: 'lot', id: parts[1] || firstRow().id };
  return { mode: 'lot', id: parts.slice(1).join('/') || parts[0] };
}

function go(hash) {
  if (location.hash !== hash) location.hash = hash;
  else apply();
}

function buildLevel(route) {
  if (route.mode === 'index') return null;
  if (route.mode === 'daily') return dailyBoard(route.date);
  if (route.mode === 'random') return randomLevel(route.token, route.band);
  const row = byId(route.id);
  if (row) return row;
  const fallback = firstRow();
  toast(`没有这张 LOT：${route.id}，回到第一关`);
  return fallback;
}

function apply() {
  const route = parse(location.hash);
  app.hash = location.hash;
  // A new chart is a new board, and the card the last one finished with must not stay over it:
  // .curtain is fixed, inset:0, z-index:30, so a card left up makes the fresh board unclickable —
  // which is exactly what the automated finger hit when it loaded lot-4p-5 out of a finished tower.
  el.curtain.hidden = true;
  if (route.mode === 'index') {
    app.mode = 'index';
    app.level = null;
    app.game = null;
    view.setGame(null);
    renderIndex();
    document.body.dataset.mode = 'index';
    el.index.hidden = false;
    el.routeBox.hidden = true;
    return;
  }
  el.index.hidden = true;
  el.routeBox.hidden = false;
  app.mode = route.mode;
  app.level = buildLevel(route);
  app.game = createGame(app.level);
  app.hints = 0;
  app.demoStop && app.demoStop();
  view.setGame(app.game);
  const list = campaign();
  app.index = list.findIndex((l) => l.id === app.level.id);
  document.body.dataset.mode = app.mode;
  render();
}

// ---- a move, from anywhere ------------------------------------------------------------------
// Which half of the rule said no, in the words the toast prints. `moveTop` above stays the only
// thing that bills a move: this reads the same exported `pegTops` and `pegStepOk` that the single
// predicate `canMove` consults, so the message is derived from the two facts the rule uses and
// cannot disagree with the refusal it is explaining. A shake alone left a 线柱 player guessing
// whether they had broken the size rule or the adjacency rule — two different things to learn.
function refusalReason(from, to) {
  const g = app.game;
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= g.pegs || to < 0 || to >= g.pegs) {
    return '棋盘边上没有更多柱子';
  }
  if (from === to) return '同一根柱上不算移';
  if (!pegStepOk(from, to, g.rule)) return '线柱：只能移到相邻柱';
  const tops = pegTops(g.state, g.n, g.pegs);
  if (tops[from] < 0) return `${PEG_NAMES[from]} 柱是空的，没有盘可拿`;
  if (tops[to] !== -1 && tops[to] < tops[from]) return `大盘不能压小盘：${PEG_NAMES[to]} 柱顶是第 ${tops[to] + 1} 号盘`;
  return '这一步不合规则';
}

function commit(from, to, via = 'pointer') {
  if (!app.game || app.game.done) return false;
  const ok = moveTop(app.game, from, to);
  if (!ok) {
    view.shakePeg(from);
    toast(refusalReason(from, to));
    render();
    return false;
  }
  const mv = app.game.history[app.game.history.length - 1];
  view.travel.set(mv.disk, { from: mv.from, to: mv.to, t0: performance.now() });
  view.settle();
  if (via === 'hint') app.hints++;
  if (app.game.done) onFinish();
  render();
  return true;
}

// The canvas answers a rejected drag itself (its `up()` never reaches a billed move), so the
// pointer door gets its wording from the same helper through the `refuse` hook above.
function lastToast() {
  return el.toast.hidden ? '' : el.toast.textContent;
}

// The win card. Graded strictly against the measured bound: matching it is a certified solution,
// beating it is impossible by the proof bake ran, exceeding it is a completion and says so.
function onFinish() {
  const g = app.game;
  const par = g.par;
  const certified = g.moves === par;
  const gradeNow = grade(g);
  const isDaily = app.mode === 'daily';
  if (isDaily) markDaily(app.level.id.replace(/^daily-/, ''), g.moves);
  app.lastRecord = recordResult(app.level, { moves: g.moves, win: true, certified }).ok;
  el.cardTitle.textContent = certified ? '认证解' : '已通关，但未达已证下界';
  el.cardBody.innerHTML = '';
  const add = (k, v) => {
    const row = document.createElement('div');
    row.className = 'cardrow';
    const b = document.createElement('b');
    b.textContent = k;
    row.appendChild(b);
    row.appendChild(document.createTextNode(v));
    el.cardBody.appendChild(row);
  };
  add('已用步数', String(g.moves));
  add('已证下界', `${par}${g.metrics && g.metrics.exact === false ? '（构建期穷尽）' : ''}`);
  add('超出', certified ? '0 步 · 与下界一致' : `${g.moves - par} 步`);
  add('评级', `${gradeNow.label} ${'★'.repeat(gradeNow.stars)}${'☆'.repeat(3 - gradeNow.stars)}`);
  add('塔形', `${g.n} 盘 ${g.pegs} 柱 · 状态空间 ${g.states ? g.states.toLocaleString('en-US') : stateCount(g.n, g.pegs).toLocaleString('en-US')} 态`);
  add('存档', app.lastRecord ? '已写入本机' : '本机不可写，仅本次会话');
  const next = app.mode === 'lot' ? LOTS.slice().sort((a, b) => a.order - b.order)[Math.min(LOTS.length - 1, (app.index < 0 ? 0 : app.index) + 1)] : null;
  el.cardNext.hidden = !(next && next.id !== app.level.id);
  if (next && next.id !== app.level.id) el.cardNext.dataset.href = `#/lot/${next.id}`;
  el.curtain.hidden = false;
  view.flash(420);
}

// ---- rendering ------------------------------------------------------------------------------
function txt(node, v) { node.textContent = v; }

function render() {
  const g = app.game;
  if (!g) return;
  const lv = app.level;
  const left = remaining(g);
  const over = overPar(g);
  txt(el.lotId, lv.id || '—');
  txt(el.band, `${(BANDS.find((t) => t.key === lv.tier) || { label: '—' }).label} · ${lv.tier}`);
  // A 线柱 board has to say so on the same line as its shape: the pegs look identical to the
  // published game's, and the whole difference is which drags the rule accepts.
  txt(el.shape, `${lv.n} 盘 / ${lv.pegs} 柱${lv.rule === 'line' ? ' · 仅相邻' : ''}${lv.kind === 'scramble' ? ' · 乱盘' : ' · 全塔'}`);
  txt(el.steps, String(g.moves));
  txt(el.par, String(lv.par));
  txt(el.left, left === null ? '—' : String(left));
  txt(el.over, over > 0 ? `超 ${over} 步` : left === 0 || g.done ? '与下界一致' : '未超');
  txt(el.space, `${lv.pegs}^${lv.n} = ${stateCount(lv.n, lv.pegs).toLocaleString('en-US')} 态`);
  txt(el.ways, lv.ways === undefined || lv.ways === null ? '—（乱盘行不穷举路线数）' : `${lv.ways} 条最短路线`);
  txt(el.proof, lv.metrics && lv.metrics.proof ? lv.metrics.proof : '—');
  txt(el.best, bestOf(lv.id, loadSave()) === null ? '无' : String(bestOf(lv.id, loadSave())));
  const disk = loadSave();
  txt(el.unlocked, `${unlockedIds(disk).length} 已解锁 · ${doneList(disk).length} 有记录`);
  txt(el.today, todayKey());
  txt(el.cap, `穷尽上限 ${EXHAUST_LIMIT.toLocaleString('en-US')} 态 · 浏览器内 ≤ ${TABLE_BUDGET.toLocaleString('en-US')} 态自扫`);
  const mv = hint(g);
  txt(el.hintline, g.done ? '已完成' : !mv ? '此位置的最短路线不在浏览器已知范围内' : `提示：第 ${mv.disk + 1} 号盘 ${PEG_NAMES[mv.from]} → ${PEG_NAMES[mv.to]}${left === null ? '' : `（剩 ${left} 步）`}`);
  txt(el.saveState, selfTest().ok ? '存档可用' : '存档不可用（隐私模式？仅本次会话）');
  txt(el.counter, `${BAKE.counterProof || 'counter-proof n=3: strict 7 vs rule-free 3'} · 无此规则下界更小，故规则是问题的一部分`);
  el.restart.disabled = false;
  el.undo.disabled = g.moves === 0;
}

function renderIndex() {
  el.indexList.innerHTML = '';
  const head = document.createElement('p');
  head.textContent = `${LOTS.length} 张 LOT，par 全部由穷尽 BFS 量出并与闭式（3 柱 2^n−1 / 4 柱 Frame-Stewart / 线柱 3^n−1）对账；最大图 ${maxStates().toLocaleString('en-US')} 态。`;
  el.indexList.appendChild(head);
  for (const row of LOTS) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    // row.id, never a re-derivation from the printed fields: `lot-${pegs}p-${n}` would send a 线柱
    // row to the free tower of the same shape — a different graph, a different par, same numbers on
    // the screen until you click.
    a.href = `#/lot/${row.id}`;
    a.textContent = describe(row);
    li.appendChild(a);
    const done = bestOf(row.id, loadSave());
    const tag = document.createElement('span');
    tag.textContent = done === null ? '未通关' : `记录 ${done} 步`;
    li.appendChild(tag);
    el.indexList.appendChild(li);
  }
  const meta = document.createElement('p');
  const b = document.createElement('b');
  b.textContent = '难度带（实测 par 区间）：';
  meta.appendChild(b);
  meta.appendChild(document.createTextNode(bands().map((x) => `${x.label} 全塔 ${x.canonicalParRange[0]}–${x.canonicalParRange[1]}，乱盘 ${x.scrambleParRange ? x.scrambleParRange.join('–') : '—'}`).join('；')));
  el.indexList.appendChild(meta);
  const fs = document.createElement('p');
  fs.textContent = `四柱 Frame-Stewart 已公布值 n=1..12：${FS_RANGE.join(', ')}（本表只收 4^10 以内的行；n=11→65、n=12→81 因超出 ${EXHAUST_LIMIT.toLocaleString('en-US')} 态穷尽上限而不发行，仅在测试中核对）。三柱闭式 n=1..14：${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(closedForm3).join(', ')}。`;
  el.indexList.appendChild(fs);
  const line = document.createElement('p');
  const lineRows = LOTS.filter((r) => r.rule === 'line');
  line.textContent = `线柱（三柱成排，只许移到相邻柱）闭式 3^n−1：${lineRows.map((r) => r.par).join(', ')}。发行到 n=${lineRows.length} 为止，因为线柱没有 O(n) 递推可用（三柱闭式 2^n−1 那条假设盘能跳到任意柱），浏览器只能自扫 3^${lineRows.length} = ${(3 ** lineRows.length).toLocaleString('en-US')} 态以内的图，上限 ${TABLE_BUDGET.toLocaleString('en-US')}；n=${lineRows.length + 1} 的 ${stateCount(lineRows.length + 1, 3).toLocaleString('en-US')} 态超出它，故不发行。线柱行最短路线数全部实测为 1。`;
  el.indexList.appendChild(line);
  const gen = document.createElement('p');
  gen.textContent = `生成器实测：接受率 ${(BAKE.acceptance * 100).toFixed(0)}%，平均 par ${BAKE.meanScramblePar}，随机走步长度中位数随步数增长（${BAKE.walkStudy.map((w) => `k=${w.k}→${w.median}`).join(', ')}）。`;
  el.indexList.appendChild(gen);
  const st = tableStats();
  const tail = document.createElement('p');
  tail.textContent = `构建检查 ${st.checks} 项；每日题与随机题的 par 是该盘面实测距离，不是同塔形全塔的 2^n−1（见 README「两个刻意的偏离」）。`;
  el.indexList.appendChild(tail);
}

// ---- controls -------------------------------------------------------------------------------
el.undo.addEventListener('click', () => {
  if (!app.game) return;
  undo(app.game);
  view.snap();
  render();
});
el.hint.addEventListener('click', () => {
  if (!app.game || app.game.done) return;
  const mv = hint(app.game);
  if (!mv) {
    toast('这个位置的最短路线不在浏览器可测范围内，只能给出下界');
    return;
  }
  app.hints++;
  view.showHint(true);
  txt(el.hintline, `提示：第 ${mv.disk + 1} 号盘 ${PEG_NAMES[mv.from]} → ${PEG_NAMES[mv.to]}`);
  toast('已高亮一步（未代走）');
});
el.restart.addEventListener('click', () => {
  if (!app.game) return;
  resetGame(app.game);
  el.curtain.hidden = true;
  view.snap();
  render();
});
el.close.addEventListener('click', () => { el.curtain.hidden = true; });
el.cardNext.addEventListener('click', () => { go(el.cardNext.dataset.href); });
el.hintToggle.addEventListener('click', () => {
  view.showHint(!view.hintOn);
  el.hintToggle.setAttribute('aria-pressed', String(view.hintOn));
  txt(el.hintToggle, view.hintOn ? '提示高亮：开' : '提示高亮：关');
});
el.demo.addEventListener('click', () => {
  if (app.demoTimer) { stopDemo('演示已停止'); return; }
  if (!app.game || app.game.done) return;
  el.demo.textContent = '停止演示';
  app.demoTimer = setInterval(() => {
    const mv = nextMove(app.game);
    if (!mv) { stopDemo('这条路浏览器不认，演示停在认证范围外'); return; }
    commit(mv.from, mv.to, 'hint');
    if (app.game.done) stopDemo('演示完成：步数与已证下界一致');
  }, 260);
  toast('演示：按认证路线走');
});
function stopDemo(msg) {
  if (app.demoTimer) clearInterval(app.demoTimer);
  app.demoTimer = 0;
  el.demo.textContent = '自动演示';
  if (msg) toast(msg);
  render();
}
app.demoStop = stopDemo;

el.reset.addEventListener('click', () => {
  if (!app.wipeArmed) {
    app.wipeArmed = true;
    el.reset.textContent = '再点一次以清空本机存档';
    setTimeout(() => {
      app.wipeArmed = false;
      el.reset.textContent = '清空存档';
    }, 4000);
    return;
  }
  wipeSave();
  app.wipeArmed = false;
  el.reset.textContent = '清空存档';
  toast('存档已清空');
  render();
});

window.addEventListener('hashchange', apply);
window.addEventListener('resize', () => view.measure());
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = ev.key.toLowerCase();
  if (k === 'escape' && !el.curtain.hidden) el.curtain.hidden = true;
  else if (k === 'u') el.undo.click();
  else if (k === 'h') el.hint.click();
  else if (k === 'r') el.restart.click();
  else if (k === 'd') el.demo.click();
});

view.measure();
apply();

// ---- the test hook --------------------------------------------------------------------------
window.hanoi = {
  version: 1,
  get state() {
    const g = app.game;
    const lv = app.level;
    return {
      mode: app.mode,
      id: lv && lv.id,
      tier: lv && lv.tier,
      kind: lv && lv.kind,
      rule: (lv && lv.rule) || 'free',
      index: app.index,
      n: g && g.n,
      pegs: g && g.pegs,
      steps: g && g.moves,
      par: lv && lv.par,
      left: g ? remaining(g) : -1,
      over: g ? overPar(g) : 0,
      refused: g ? g.refused : 0,
      hints: app.hints,
      done: !!(g && g.done),
      exact: g ? isExact(g) : null,
      state: g ? g.state : null,
      goal: g ? g.goal : null,
      start: g ? g.start : null,
      tops: g ? Array.from(pegTops(g.state, g.n, g.pegs)) : [],
      digits: g ? decode(g.state, g.n, g.pegs) : [],
      grade: g && g.done ? grade(g).key : null,
      curtain: !el.curtain.hidden,
      cardTitle: el.cardTitle.textContent,
      demo: !!app.demoTimer,
      best: lv ? bestOf(lv.id, loadSave()) : null,
      painted: view.painted,
      frames: view.frames,
      hash: location.hash,
    };
  },
  rows: () => rowList(),
  table: () => LOTS.map((r) => ({ id: r.id, pegs: r.pegs, n: r.n, par: r.par, ways: r.ways, states: r.states, tier: r.tier, rule: r.rule })),
  bandOf: (date) => dailyBand(date),
  census: () => ({ limit: EXHAUST_LIMIT, tableBudget: TABLE_BUDGET, rows: LOTS.length, maxStates: maxStates(), bakedChecks: BAKE.checks, counterProof: BAKE.counterProof, walkStudy: BAKE.walkStudy }),
  fs: (n) => fsPar(n),
  closed: (n) => closedForm3(n),
  lineClosed: (n) => closedFormLine(n),
  toastText: lastToast,
  load(hash) { go(hash); return app.level && app.level.id; },
  level() { const lv = app.level; return lv ? { id: lv.id, pegs: lv.pegs, n: lv.n, rule: lv.rule || 'free', start: lv.start, goal: lv.goal, par: lv.par, kind: lv.kind, tier: lv.tier } : null; },
  // The certified continuation from wherever the board stands now, computed without touching it.
  route() {
    const g = app.game;
    if (!g) return [];
    const out = [];
    let s = g.state;
    let i = g.moves;
    let guard = 0;
    while (s !== g.goal && guard++ < 20000) {
      const mv = g.metrics.next(s, i);
      if (!mv) break;
      out.push({ disk: mv.disk, from: pegOf(s, mv.disk, g.pegs), to: mv.to });
      s = applyMove(s, mv.disk, mv.to, g.n, g.pegs);
      i++;
    }
    return out;
  },
  // The same predicate the player is billed by, with the level's own rule: an `H.legal()` that read
  // the free graph would hand a test a 线柱 "legal move" the game then refuses.
  legal: () => (app.game ? legalMoves(app.game.state, app.game.n, app.game.pegs, app.game.rule) : []),
  // Where an automated finger has to press, in client pixels.
  diskPoint(disk) { return view.diskPoint(disk); },
  pegPoint(peg, slot) { return view.pegPoint(peg, slot); },
  geom() { const g = view.geom(); return { w: g.usable + g.pad * 2, h: view.h, pegs: g.pegs, n: g.n, rule: g.rule, centers: [...Array(g.pegs).keys()].map((p) => g.center(p)), diskH: g.diskH, floor: g.floor }; },
  canvasRect() { const r = el.board.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; },
  move(from, to) { return commit(from, to, 'hook'); },
  hintOnce() { el.hint.click(); return { hints: app.hints, line: el.hintline.textContent }; },
  undoOnce() { el.undo.click(); return app.game ? app.game.moves : -1; },
  restart() { el.restart.click(); return app.game ? app.game.moves : -1; },
  demoStart() { el.demo.click(); return !!app.demoTimer; },
  demoStop() { stopDemo(''); return app.demoTimer === 0; },
  closeCard() { el.curtain.hidden = true; return el.curtain.hidden; },
  pixels() { return view.pixels(); },
  painted() { return view.painted; },
  frames: () => view.frames,
  save() { return loadSave(); },
  saveStats() { return saveStats(); },
  selfTest: () => selfTest(),
  resetSave() { const ok = wipeSave(); render(); return ok; },
  tableStats,
  view,
};

// ---- 全屏开关 ----
//
// 绑到 index.html 的 HUD 里真实存在的 #btn-fullscreen。
// 只在 js 里留一串 requestFullscreen 能骗过字符串扫描，但按钮不在 DOM 里就是死代码：
// 玩家按不到，功能等于没做。所以 id 必须与 HTML 里的按钮对得上，缺失时要在控制台喊出来。
//
// 三套 API 一律**特性探测**，不做 UA 判断：iPhone 版 Safari 压根没有元素全屏（只有 <video> 能全屏），
// 老 Edge 只认 ms 前缀，Firefox 认 moz 前缀。UA 字符串是猜的，方法在不在是量的，猜错就静默失效。
function fsRoot() {
  return document.documentElement;
}

function fsElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function fsRequest(root) {
  // 老 Edge 的 msRequestFullscreen 挂在元素上，和标准名同一个位置，所以并排取即可。
  return root.requestFullscreen || root.webkitRequestFullscreen || root.msRequestFullscreen || null;
}

// iOS Safari 会把非 video 元素的请求直接 reject 成 NotAllowedError。
// 这个 promise 没人接就升级成 unhandledrejection，冒到 window.onerror——离屏预载时足以把整页判死。
// 因此凡是可能返回 promise 的调用，返回值一律就地吞掉，绝不让拒绝逃出这一层。
function fsQuiet(p) {
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return p;
}

// 返回 true=请求进入，false=请求退出，null=不支持（调用方据此禁用按钮）。
function toggleFullscreen(root) {
  const req = fsRequest(root);
  if (!req) return null;
  if (fsElement()) {
    // 退出侧同样要兜底：老 Edge 是 msExitFullscreen；万一三者皆无就当无事发生，不抛。
    const exit = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (exit) fsQuiet(exit.call(document));
    return false;
  }
  // 部分实现（如被 Permissions-Policy 挡住的 iframe）会同步抛，所以 catch 和 .catch 两头都要接。
  try {
    fsQuiet(req.call(root));
  } catch (err) {
    // 拒绝即降级：静默保持当前形态，不冒泡、不打断这一局的其余逻辑。
  }
  return true;
}

function bindFullscreen(btn) {
  const root = fsRoot();

  // 状态回写：Esc 和 iOS 下滑手势退出时不会经过按钮，
  // 只有 fullscreenchange 事件能把按钮的文案/字形拉回正确状态，否则它会一直假装自己在全屏里。
  const sync = () => {
    const on = !!fsElement();
    btn.setAttribute('aria-pressed', String(on));
    // 该按钮第一个子节点是文字，后面挂着 <kbd>；只换文字节点，保留 kbd 结构。
    if (btn.firstChild) btn.firstChild.textContent = on ? "退出全屏 " : "全屏 ";
    btn.title = on ? "退出全屏 (F)" : "全屏 (F)";
    document.body.classList.toggle('is-fullscreen', on);
    return on;
  };

  if (!fsRequest(root)) {
    // 不支持就要说明为什么：只把按钮变灰，玩家会以为这活根本没做完。
    btn.disabled = true;
    btn.setAttribute('aria-disabled', 'true');
    btn.title = '这个浏览器不提供元素全屏（iOS Safari 请用「添加到主屏幕」）';
    return;
  }

  btn.addEventListener('click', () => {
    toggleFullscreen(root);
    sync();
  });

  document.addEventListener('fullscreenchange', sync);
  document.addEventListener('webkitfullscreenchange', sync);

  window.addEventListener('keydown', (ev) => {
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // 正在输入框里打字时不劫持按键，否则会打不出 f。
    if (ev.target && /^(input|textarea|select)$/i.test(ev.target.tagName)) return;
    if (ev.key === "f" || ev.key === "F") {
      ev.preventDefault();
      toggleFullscreen(root);
      sync();
    }
  });

  sync();
}

function bootFullscreen() {
  const btn = document.getElementById("btn-fullscreen");
  if (!btn) {
    // 按钮被谁删掉了？在控制台喊出来，别让这个坑静默地烂在下一棒手里。
    console.warn('[fullscreen] index.html 里找不到 #' + "btn-fullscreen" + '，全屏开关没有入口');
    return;
  }
  bindFullscreen(btn);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootFullscreen);
} else {
  bootFullscreen();
}
