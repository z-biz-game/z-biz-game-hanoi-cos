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
import { bestOf, dailyDone, doneList, load as loadSave, markDaily, recordResult, reset as wipeSave, selfTest, setSetting, settings as readSettings, stats as saveStats, unlockedIds } from './core/storage.js';
import { todayKey } from './core/rng.js';
// BANDS, not TIERS: TIERS is the four *free* difficulty bands the daily and random generators
// partition, and make.dailyLevel hashes a date into `hash % TIERS.length` — adding 线柱 there would
// silently re-band every date already played. BANDS is TIERS plus the appended 线柱 band, and it is
// what a route or a label has to be looked up in, or `#/random/line/…` falls back to shoal and the
// board mislabels itself.
import { BANDS } from './core/make.js';
import { DEMO_STEP_S, createView } from './view.js';
// 一次对局 = 一次会话：js/core/session.js 拥有那只表与那道闸（盘面落子、演示推子都要先过它）。
import { createSession } from './core/session.js';
// 听觉与触觉这两路反馈：音频单例自己管手势解锁与真静音，这里只管把音接到真实事件上。
import { audio } from './audio.js';
import { haptics } from './haptics.js';
import { setupPwa } from './pwa.js';

const $ = (id) => document.getElementById(id);
const el = {};
for (const id of ['board', 'stage', 'lotId', 'band', 'shape', 'steps', 'left', 'over', 'elapsed', 'par', 'space', 'ways', 'proof', 'best', 'unlocked', 'hintline', 'undo', 'hint', 'restart', 'demo', 'demoLabel', 'hintToggle', 'pause', 'pauseLabel', 'mute', 'muteLabel', 'full', 'fullLabel', 'help', 'pausedBanner', 'curtain', 'card', 'cardTitle', 'cardBody', 'cardNext', 'close', 'helpCurtain', 'helpClose', 'index', 'indexList', 'toast', 'reset', 'saveState', 'today', 'cap', 'counter', 'routeBox', 'pwaState', 'install']) {
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
  wipeArmed: false,
  lastRecord: null,
  demo: { on: false, acc: 0, unsub: null },
  pwa: null,
  installable: false,
};

// 一局一次会话：表走 performance.now()（单调钟），暂停时表停住，输入闸由 allowInput() 回答。
const session = createSession(() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
function resetSession(start = false) {
  session.reset();
  if (start) session.start();
}

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
    sfx('refuse');
    if (info.reason === 'nothing to lift') return `${PEG_NAMES[info.peg]} 柱是空的，没有盘可拿`;
    // 'shaft' 和空柱是两件事：柱上有盘，只是按下点没落进任何一片的命中带。说成"空的"会把玩家
    // 推去按同一个位置的第二次、第三次。
    if (info.reason === 'shaft') return `${PEG_NAMES[info.peg]} 柱上没有对准盘：按在最上面那片的 44px 命中带里`;
    return refusalReason(info.from, info.to);
  },
  // 拿起一盘的声音归手势，不归结算：拖动还没被规则认可时玩家也该听见"手里有东西了"。
  lift: () => sfx('lift'),
  hint: () => (app.demo.on ? null : nextMove(app.game)),
  // 暂停期按盘面：搬运一条都不该发生（view 在 down() 第一行就返回了），但得告诉玩家为什么没反应。
  'paused-input': () => { toast('已暂停：按 P 或点「继续」再搬盘'); return null; },
});

// Read from the canvas, not retyped: a toast and the board must never name the same peg apart.
const PEG_NAMES = view.PEG_NAMES;

function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => { el.toast.hidden = true; }, 2200);
}

// 声音只有这一道门。旧的音名在这里映射到远端单例的 VOICES，触觉跟着同一件事一起发：
//   lift → tap（拿起盘）／drop → correct（有效操作成功）／refuse → wrong（规则拒绝了）
//   ui → tap（界面点击）／win|fanfare → win（通关只由 onFinish 里的这一声负责）
function sfx(kind) {
  switch (kind) {
    case 'lift':
    case 'ui':
      haptics.tap();
      return audio.play('tap');
    case 'drop':
      haptics.correct();
      return audio.play('correct');
    case 'refuse':
      haptics.wrong();
      return audio.play('wrong');
    case 'win':
    case 'fanfare':
      haptics.correct();
      return audio.play('win');
    default:
      return audio.play(kind);
  }
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
  // The 玩法说明 veil is the same class of bug with the same fix, so it goes up with the card.
  el.curtain.hidden = true;
  el.helpCurtain.hidden = true;
  if (route.mode === 'index') {
    app.mode = 'index';
    app.level = null;
    app.game = null;
    resetSession();      // 目录页没有对局：表停、暂停态清干净
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
  resetSession(true);  // 新的一局：表从头走，暂停态清干净
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
  // 暂停冻住的必须是两条门：画布在 down() 里就不接了，键盘与测试钩子走的是这里，否则暂停中
  // 按 R/拖钩子照样能改账本，那暂停就是个装饰。session 是那条闸的唯一答案。
  if (!session.allowInput() || view.paused) {
    toast('已暂停：按 P 继续后再搬盘');
    audio.play('blocked');
    return false;
  }
  const ok = moveTop(app.game, from, to);
  if (!ok) {
    view.shakePeg(from);
    sfx('refuse');
    toast(refusalReason(from, to));
    render();
    return false;
  }
  const mv = app.game.history[app.game.history.length - 1];
  // t0 记在 view.clock 上，不记在墙上：暂停要把飞行冻住，30Hz 与 120Hz 要在同一步虚拟时长后
  // 画出同一张图，这两件事都只有"动画和累加器同一条时间轴"才成立。
  view.arm(mv.disk, mv.from, mv.to);
  if (via === 'hint') app.hints++;
  if (app.game.done) onFinish();   // 收官那一响是 win，在 onFinish 里；这里不再补 correct
  else sfx('drop');
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
  session.stop();      // 通关了：表停在这一刻
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
  add('用时', fmtElapsed(session.elapsedMs()));
  add('已证下界', `${par}${g.metrics && g.metrics.exact === false ? '（构建期穷尽）' : ''}`);
  add('超出', certified ? '0 步 · 与下界一致' : `${g.moves - par} 步`);
  add('评级', `${gradeNow.label} ${'★'.repeat(gradeNow.stars)}${'☆'.repeat(3 - gradeNow.stars)}`);
  add('塔形', `${g.n} 盘 ${g.pegs} 柱 · 状态空间 ${g.states ? g.states.toLocaleString('en-US') : stateCount(g.n, g.pegs).toLocaleString('en-US')} 态`);
  add('存档', app.lastRecord ? '已写入本机' : '本机不可写，仅本次会话');
  const next = app.mode === 'lot' ? LOTS.slice().sort((a, b) => a.order - b.order)[Math.min(LOTS.length - 1, (app.index < 0 ? 0 : app.index) + 1)] : null;
  el.cardNext.hidden = !(next && next.id !== app.level.id);
  if (next && next.id !== app.level.id) el.cardNext.dataset.href = `#/lot/${next.id}`;
  el.curtain.hidden = false;
  sfx(certified ? 'fanfare' : 'win');
  view.flash(420);
}

// ---- rendering ------------------------------------------------------------------------------
function txt(node, v) { node.textContent = v; }

// 「用时」走玩家的表：分:秒，暂停时不涨。不到一分钟也照这个写法，玩家不必猜单位。
function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

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
  txt(el.elapsed, fmtElapsed(session.elapsedMs()));
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
// 暂停冻住的是 view.clock 的累加，不是一个布尔装饰：演示、飞行、抖动、闪光全部读同一条时间轴，
// 所以一起停；撤销与重来是玩家主动命令，允许在暂停里执行（它们把画面 snap 回静态，不会补画历史）。
el.undo.addEventListener('click', () => {
  if (!app.game) return;
  undo(app.game);
  sfx('ui');
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
  sfx('ui');
  view.showHint(true);
  txt(el.hintline, `提示：第 ${mv.disk + 1} 号盘 ${PEG_NAMES[mv.from]} → ${PEG_NAMES[mv.to]}`);
  toast('已高亮一步（未代走）');
});
el.restart.addEventListener('click', () => {
  if (!app.game) return;
  resetGame(app.game);
  // 提示次数与演示累加器是「这一趟」的状态：不清的话，重开后的第一步演示会提前最多一帧到来
  // （实测 0.2167s < DEMO_STEP_S 0.26s），而面板上的 hints 还带着上一趟的数。
  app.hints = 0;
  if (app.demo.on) app.demo.acc = 0;
  // `refused` 不归这里：它是「这张 LOT」的违规账，由 apply() 在换图时清零（tools/playtest.mjs
  // 的 @pointer 段落就靠它跨重开成立）。
  el.curtain.hidden = true;
  resetSession(true);  // 重来一局：表归零，暂停态清干净
  sfx('ui');
  view.snap();
  render();
});
el.close.addEventListener('click', () => { el.curtain.hidden = true; });
el.cardNext.addEventListener('click', () => { go(el.cardNext.dataset.href); });
el.hintToggle.addEventListener('click', () => {
  view.showHint(!view.hintOn);
  setSetting('hintOn', view.hintOn);
  el.hintToggle.setAttribute('aria-pressed', String(view.hintOn));
  txt(el.hintToggle, view.hintOn ? '提示高亮：开' : '提示高亮：关');
  sfx('ui');
});

// ---- pause / mute / fullscreen / 玩法说明 ---------------------------------------------------
// 暂停冻住的是 view.clock 的累加（js/view.js 的 tick），不是一个布尔装饰：飞行、抖动、闪光、
// 演示读同一条时间轴，所以一起停。按钮只翻标签和 aria-pressed，状态本身向 view 要。
function applyPaused() {
  const now = !!view.paused;
  el.pause.setAttribute('aria-pressed', String(now));
  txt(el.pauseLabel, now ? '继续' : '暂停');
  el.pausedBanner.hidden = !now;
  document.body.dataset.paused = now ? 'on' : 'off';
  return now;
}
el.pause.addEventListener('click', () => {
  const next = !view.paused;
  view.pause(next);
  if (next) session.pause(); else session.resume();
  applyPaused();
  sfx('ui');
});

function applyMuted(on) {
  audio.setMuted(on);
  const now = audio.muted;
  el.mute.setAttribute('aria-pressed', String(now));
  txt(el.muteLabel, now ? '已静音' : '静音：关');
  setSetting('muted', now);
  return now;
}
el.mute.addEventListener('click', () => {
  const now = applyMuted(!audio.muted);
  // 取消静音才建上下文；静音状态下 AudioContext 连存在都不必，建了又被 autoplay 策略挂起来。
  if (!now && audio.unlock()) sfx('ui');
});

function applyFullscreen() {
  const on = !!document.fullscreenElement;
  el.full.setAttribute('aria-pressed', String(on));
  txt(el.fullLabel, on ? '退出全屏' : '全屏');
}
// 全屏绑在这个 HUD 上真实存在的 #full 按钮上：Chrome 只允许在用户手势里请求，所以它就是唯一入口。
el.full.addEventListener('click', () => {
  sfx('ui');
  if (document.fullscreenElement) {
    const p = document.exitFullscreen && document.exitFullscreen();
    if (p && p.catch) p.catch(() => toast('浏览器拒绝退出全屏'));
    return;
  }
  // 全屏对象是整张页面而不是那块画布：只把 #stage 撑满屏幕会把带数字与按钮的面板留在外面，
  // 玩家就只剩 Esc 一条退路——HUD 上的「退出全屏」必须真的看得见才配叫退出。
  const target = document.documentElement;
  if (!target.requestFullscreen) { toast('这台设备没有全屏 API'); return; }
  const p = target.requestFullscreen();
  // 请求被拒（老 WebView、被 iframe 策略挡住）不抛未捕获 rejection：控制台干净是红门槛。
  if (p && p.catch) p.catch(() => toast('浏览器拒绝了全屏请求'));
});
document.addEventListener('fullscreenchange', applyFullscreen);

function openHelp(on) {
  el.helpCurtain.hidden = !on;
  if (on) {
    setSetting('tutorialSeen', true);
    applyHelpNudge();
    sfx('ui');
  }
}
el.help.addEventListener('click', () => openHelp(el.helpCurtain.hidden));
el.helpClose.addEventListener('click', () => {
  el.helpCurtain.hidden = true;
  sfx('ui');
});

el.demo.addEventListener('click', () => {
  if (app.demo.on) { stopDemo('演示已停止'); return; }
  startDemo();
});
function startDemo() {
  if (!app.game || app.game.done) return false;
  if (view.paused) { toast('已暂停：继续后才能自动演示'); return false; }
  app.demo.on = true;
  app.demo.acc = 0;
  txt(el.demoLabel, '停止演示');
  el.demo.setAttribute('aria-pressed', 'true');
  // 演示走的是帧回调，累加 view.clock 的 dt：暂停即冻住，30/60/120Hz 下每 DEMO_STEP_S 秒虚拟
  // 时长走一步，与墙钟 setInterval 不同 —— 后者在暂停时照样推进、掉帧时还会补走好几步。
  view.keepPumping(true);
  app.demo.unsub = view.onFrame((dt) => {
    app.demo.acc += dt;
    while (app.demo.acc >= DEMO_STEP_S) {
      app.demo.acc -= DEMO_STEP_S;
      const mv = nextMove(app.game);
      if (!mv) { stopDemo('这条路浏览器不认，演示停在认证范围外'); return; }
      commit(mv.from, mv.to, 'hint');
      if (app.game.done) { stopDemo('演示完成：步数与已证下界一致'); return; }
    }
    return undefined;
  });
  toast('演示：按认证路线走');
  return true;
}
function stopDemo(msg) {
  app.demo.on = false;
  if (app.demo.unsub) app.demo.unsub();
  app.demo.unsub = null;
  app.demo.acc = 0;
  view.keepPumping(false);
  el.demo.textContent = '自动演示';
  el.demo.setAttribute('aria-pressed', 'false');
  if (msg) toast(msg);
  render();
}
app.demoStop = stopDemo;

el.install.addEventListener('click', () => {
  sfx('ui');
  const p = app.pwa && app.pwa.promptInstall();
  if (p && p.then) p.then((ok) => { if (!ok) toast('安装请求没被接受'); });
});

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

// 键位。有卡片挡在前面时 Enter/Space/Esc 只关卡片（"开始"），不会同时把暂停翻一遍；焦点在按钮
// 或链接上时让浏览器的默认 click 走，否则空格会被读成两次动作。
const KEY_HINTS = {
  u: 'undo', h: 'hint', r: 'restart', d: 'demo', p: 'pause', m: 'mute', f: 'full',
};
window.addEventListener('keydown', (ev) => {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const k = String(ev.key || '').toLowerCase();
  const veilUp = !el.curtain.hidden || !el.helpCurtain.hidden;
  const onControl = /^(button|a|input|textarea|select)$/i.test((ev.target && ev.target.tagName) || '');
  if (k === 'escape') {
    if (veilUp) { el.curtain.hidden = true; el.helpCurtain.hidden = true; }
    return;
  }
  if (k === 'enter' || k === ' ') {
    if (veilUp) {
      ev.preventDefault();
      el.curtain.hidden = true;
      el.helpCurtain.hidden = true;   // 空格就是"开始搬盘"，不必先用手指去点关闭
      return;
    }
    if (onControl) return;            // 焦点在按钮上：让默认 click 处理
    ev.preventDefault();
    el.pause.click();                 // P 与 Space 同义，暂停是这里唯一的全局动作
    return;
  }
  if (k === '?' || (k === '/' && ev.shiftKey) || k === 'f1') { openHelp(el.helpCurtain.hidden); return; }
  const which = KEY_HINTS[k];
  if (!which) return;
  el[which].click();
});

// prefers-reduced-motion 的 JS 分支：CSS 那条只管卡片入场，画布上的飞行/抖动/闪光得由这里
// 把 view 的动画时长一并置 0（js/view.js 的 view.reducedMotion 与 setReducedMotion）。
const RM = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReducedMotion(on) {
  view.setReducedMotion(!!on);
  document.body.dataset.motion = view.reducedMotion ? 'reduce' : 'full';
  return view.reducedMotion;
}
applyReducedMotion(RM ? RM.matches : false);
if (RM) {
  const onChange = () => applyReducedMotion(RM.matches);
  if (typeof RM.addEventListener === 'function') RM.addEventListener('change', onChange);
  else if (typeof RM.addListener === 'function') RM.addListener(onChange);
}

// 设置项从存档里回来，但不回写：开机就 setSetting 会把"读了什么"变成"改了什么"。
function applyLoadedSettings() {
  const s = readSettings(loadSave());
  audio.setMuted(s.muted);
  el.mute.setAttribute('aria-pressed', String(audio.muted));
  txt(el.muteLabel, audio.muted ? '已静音' : '静音：关');
  view.showHint(s.hintOn);
  el.hintToggle.setAttribute('aria-pressed', String(view.hintOn));
  txt(el.hintToggle, view.hintOn ? '提示高亮：开' : '提示高亮：关');
  el.help.dataset.seen = String(s.tutorialSeen);
  return s;
}

function applyHelpNudge() {
  el.help.dataset.seen = String(readSettings(loadSave()).tutorialSeen);
}

view.measure();
const bootSettings = applyLoadedSettings();
apply();
// 面板上的表：每半秒读一次 session 的读数。暂停时 session.elapsedMs() 不涨，读数就停住。
setInterval(() => {
  if (app.game && el.elapsed) txt(el.elapsed, fmtElapsed(session.elapsedMs()));
}, 500);
applyPaused();
applyFullscreen();
if (!bootSettings.tutorialSeen) toast('第一次玩？按 ? 或点「玩法说明」：规则、命中带和键位都在里面');

// 离线壳：注册结果写进面板，不写进 console（本仓的验收线把控制台干净算作红）。
// 放在 apply() 之后 —— 注册快慢与题面无关，一个装不上的 SW 不该让第一张塔晚到。
app.pwa = setupPwa(({ status, detail }) => {
  txt(el.pwaState, `离线壳 ${status}${detail ? ` · ${detail}` : ''}`);
  // 安装按钮只在浏览器真的发出过 beforeinstallprompt 后出现：没有 prompt 时按下不会有任何事发生，
  // 摆一个不反应的按钮比不摆更糟。iOS 那条路（手动"添加到主屏幕"）由 pwaState 的文案说明。
  el.install.hidden = status !== 'installable';
});

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
      demo: app.demo.on,
      // 暂停、时钟与动效：帧率对拍和 @boot 的暂停断言读的是这五个字段，读的是 view 的真状态而不是
      // 按钮标签 —— 标签会骗人，累加器不会。
      paused: !!view.paused,
      clock: view.clock,
      moving: view.isMoving(),
      reducedMotion: !!view.reducedMotion,
      motion: document.body.dataset.motion || 'full',
      muted: !!audio.muted,
      audio: { muted: audio.muted, unlocked: audio.unlocked, state: audio.unlocked ? 'running' : 'idle' },
      helpOpen: !el.helpCurtain.hidden,
      tutorialSeen: readSettings(loadSave()).tutorialSeen,
      fullscreen: !!document.fullscreenElement,
      pwa: el.pwaState.textContent,
      installable: !el.install.hidden,
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
  demoStart() { el.demo.click(); return app.demo.on; },
  demoStop() { stopDemo(''); return app.demo.on === false; },
  // 暂停与静音的测试入口：走按钮，不走内部函数，于是断言覆盖的是玩家真的那条路。
  pauseOn(on) {
    if (typeof on === 'boolean') { if (view.paused !== on) el.pause.click(); }
    else el.pause.click();
    return { paused: !!view.paused, clock: view.clock, frames: view.frames };
  },
  muteOn(on) {
    if (typeof on === 'boolean') { if (!!audio.muted !== on) el.mute.click(); }
    else el.mute.click();
    return { muted: !!audio.muted, unlocked: audio.unlocked };
  },
  reducedMotionOn(on) {
    applyReducedMotion(typeof on === 'boolean' ? on : !view.reducedMotion);
    return { reducedMotion: !!view.reducedMotion, motion: document.body.dataset.motion };
  },
  helpOpen(on) { openHelp(typeof on === 'boolean' ? on : el.helpCurtain.hidden); return !el.helpCurtain.hidden; },
  press(key) {
    const ev = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    window.dispatchEvent(ev);
    return { defaultPrevented: ev.defaultPrevented, paused: !!view.paused, steps: app.game ? app.game.moves : -1 };
  },
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

// ---- 减弱动效（prefers-reduced-motion）----
//
// css 里已经有一段 @media（.toast 的 transition），但 canvas 上柱子被拒时的左右摆
// CSS 拦不住，这里补 JS 分支。跟住系统设置，而且**运行中改设置要立刻生效**：只读一次
// matchMedia 不够，玩家在系统里把开关拨回来，页面还停在上一次读到的答案上。
// addEventListener 是标准接口，老 Safari 只有 addListener —— 特性探测，不做 UA 判断。
const motionQuery = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)') : null;
function applyReduceMotion(on) { view.setReduceMotion(on); }
if (motionQuery) {
  applyReduceMotion(motionQuery.matches);
  if (typeof motionQuery.addEventListener === 'function') {
    motionQuery.addEventListener('change', (e) => applyReduceMotion(e.matches));
  } else if (typeof motionQuery.addListener === 'function') {
    motionQuery.addListener((e) => applyReduceMotion(e.matches));
  }
}
window.hanoi.setReduceMotion = applyReduceMotion;
window.hanoi.isReducedMotion = () => view.isReducedMotion();
