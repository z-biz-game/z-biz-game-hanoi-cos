// Minimal CDP driver for headless playtesting (Node 21+ global WebSocket/fetch).
//
// env: CDP_PORT (devtools port, default 9352), BASE_URL (page to attach to,
//      default http://127.0.0.1:5192/)
// usage:
//   node tools/playtest.mjs open  <url>          # close our pages, open a fresh one
//   node tools/playtest.mjs nav   <url>
//   node tools/playtest.mjs eval  '<expr>'       # pass `nonav` to skip the reload
//   node tools/playtest.mjs eval  '@boot'        # | @play | @routes | @save | @reloaded | @pointer | @line
//   node tools/playtest.mjs drag  '<json>'       # one real mouse drag: {"from":[x,y],"to":[x,y]}
//   node tools/playtest.mjs shot  <path.png>
//   node tools/playtest.mjs logs
//
// Every scenario answers with { rows, fail } in the same shape tools/harness.mjs prints, on one
// line prefixed `RESULT ` so a driver can slice it out of a stdout that also carries per-assertion
// progress lines. @pointer is the one that matters most here: it drives Input.dispatchMouseEvent
// through a whole certified solution, so "the rule, the counter and the drawing agree with a
// finger" is measured, not asserted.

import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9352;
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5192/';
const SHELL_TIMEOUT = Number(process.env.SHELL_TIMEOUT || 40000);
const ORIGIN = new URL(BASE).origin;
const isOurs = (u) => typeof u === 'string' && u.startsWith(ORIGIN);
const cmd = process.argv[2];
const arg = process.argv[3];

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (globalThis.__printEvents) globalThis.__printEvents(msg);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mouseAt = (cdp, sessionId, type, x, y, buttons) => cdp.send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', buttons, clickCount: type === 'mousePressed' ? 1 : 0,
}, sessionId);

// One real drag: press on the disk the page says to grab, walk across the board in steps, and
// release over the destination column. Coordinates come from the page, never from this file.
async function dragAt(cdp, sessionId, runJS, from, to, steps = 4, hold = 45) {
  await mouseAt(cdp, sessionId, 'mousePressed', from[0], from[1], 1);
  await sleep(hold);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await mouseAt(cdp, sessionId, 'mouseMoved', from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, 1);
    await sleep(16);
  }
  await mouseAt(cdp, sessionId, 'mouseReleased', to[0], to[1], 0);
  await sleep(90);
}

// ---- scenario bodies ------------------------------------------------------------------------
const PRELUDE = `(async () => {
  const H = window.hanoi;
  const rows = [];
  const T = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail === undefined ? null : (typeof detail === 'object' ? JSON.stringify(detail) : String(detail)) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = fn(); } catch (e) { v = false; } if (v || Date.now() - t0 > ms) return v; await sleep(40); } };
  const load = async (hash) => { H.load(hash); await wait(() => H.state.hash === hash && (H.state.id || hash === '#/index')); await sleep(30); return H.state; };
  const playRoute = () => { const r = H.route(); for (const m of r) H.move(m.from, m.to); return r.length; };
  const ROW = /^n=\\d+ pegs=[34] par=\\d+ routeCount=(-|\\d+) states=\\d+ tier=\\w+$/;
`;

const POSTLUDE = `  return { rows, fail: rows.filter((r) => !r.pass).length };
})()`;

const SCENARIOS = {
  '@boot': `${PRELUDE}
  T('window.hanoi exists', !!H);
  T('hook exposes state', H && typeof H.state === 'object');
  T('default door is a baked LOT row', H.state.id === 'lot-3p-4', H.state.id);
  T('the LOT table has 32 rows', H.rows().length === 32, H.rows().length);
  T('every row prints in the six-field format', H.rows().every((l) => ROW.test(l)), H.rows()[0]);
  const t = H.table();
  T('ten of the 32 rows are 线柱', t.filter((r) => r.rule === 'line').length === 10, t.filter((r) => r.rule === 'line').length);
  T('the other 22 are the published free game', t.filter((r) => r.rule !== 'line').length === 22, t.filter((r) => r.rule !== 'line').length);
  T('every baked par is a positive integer', t.every((r) => Number.isSafeInteger(r.par) && r.par > 0));
  T('no baked row exceeds the exhaustive cap', t.every((r) => r.states <= 1594323));
  T('the deepest row is 3^13 = 8191', t.some((r) => r.n === 13 && r.pegs === 3 && r.par === 8191 && r.states === 1594323));
  T('the ten-disk four-peg row prints 49', t.some((r) => r.n === 10 && r.pegs === 4 && r.par === 49));
  T('three-peg rows each have exactly one shortest route', t.filter((r) => r.pegs === 3).every((r) => r.ways === 1));
  T('a 线柱 row prints the measured 3^n−1', t.find((r) => r.id === 'lot-line-6').par === 728, t.find((r) => r.id === 'lot-line-6').par);
  T('the deepest 线柱 row is 3^10−1 = 59048', t.find((r) => r.id === 'lot-line-10').par === 59048, t.find((r) => r.id === 'lot-line-10').par);
  T('no 线柱 row is past the sweep budget the variant needs', t.filter((r) => r.rule === 'line').every((r) => r.states <= 65536));
  T('closed form n=14 is 16383', H.closed(14) === 16383, H.closed(14));
  T('线柱 closed form n=10 is 59048', H.lineClosed(10) === 59048, H.lineClosed(10));
  T('Frame-Stewart n=12 is 81', H.fs(12) === 81, H.fs(12));
  const c = H.census();
  T('census cap is 1594323 positions', c.limit === 1594323, c.limit);
  T('census carries the bake check count', c.bakedChecks > 250, c.bakedChecks);
  T('census carries the counter-proof', /strict 7/.test(String(c.counterProof)), c.counterProof);
  T('walk study is monotone in the median', c.walkStudy.every((w, i) => !i || w.median >= c.walkStudy[i - 1].median));
  T('the canvas painted', H.state.painted === true);
  T('the draw loop advanced frames', H.state.frames > 0, H.state.frames);
  const r = H.canvasRect();
  T('the canvas is laid out, not the 300x150 default', r.w > 320 && r.h > 180, [Math.round(r.w), Math.round(r.h)]);
  T('geometry matches the board', H.geom().pegs === H.state.pegs && H.geom().centers.length === H.state.pegs);
  T('digits are one per disk', H.state.digits.length === H.state.n);
  T('tops name a disk or nothing', H.state.tops.length === H.state.pegs && H.state.tops.every((x) => Number.isInteger(x)));
  T('the page title is the product name', document.title === '汉诺塔 · HANOI', document.title);
  const bs = getComputedStyle(document.body);
  T('the stylesheet applied', bs.backgroundImage.includes('radial-gradient') && bs.color === 'rgb(232, 227, 217)', [bs.backgroundImage.slice(0, 40), bs.color]);
  T('a hidden veil is really hidden, not merely flag-set', document.getElementById('curtain').hidden === true
    && getComputedStyle(document.getElementById('curtain')).display === 'none', getComputedStyle(document.getElementById('curtain')).display);
  T('the board door is on screen', getComputedStyle(document.getElementById('routeBox')).display !== 'none', getComputedStyle(document.getElementById('routeBox')).display);
  T('the panel labels the bound as 已证下界', [...document.querySelectorAll('.numbers dt')].map((d) => d.textContent).join('|').includes('已证下界'));
  T('the hint line is live', document.getElementById('hintline').textContent.includes('提示'));
  T('the save line is present', document.getElementById('saveState').textContent.length > 0);
  T('the counter-proof line reached the panel', document.getElementById('counter').textContent.includes('strict 7'));
${POSTLUDE}`,

  '@play': `${PRELUDE}
  await load('#/lot/lot-3p-3');
  let s = H.state;
  T('lot-3p-3 loaded', s.id === 'lot-3p-3', s.id);
  T('par is the measured 7', s.par === 7, s.par);
  T('nothing billed yet', s.steps === 0 && s.refused === 0);
  T('remaining starts at the par', s.left === 7, s.left);
  T('a three-peg board is exact', s.exact === true);
  T('the certified route is 7 moves', H.route().length === 7, H.route().length);
  T('the full tower has no buried-to-free move', H.move(0, 0) === false);
  T('an illegal attempt was refused, not billed', H.state.steps === 0 && H.state.refused === 1, H.state.refused);
  T('a buried disk cannot be lifted', H.move(2, 1) === false && H.state.steps === 0);
  T('refusals accumulate without touching the position', H.state.refused === 2 && H.state.state === H.state.start, H.state.refused);
  const first = H.route()[0];
  T('the first certified hop is accepted', H.move(first.from, first.to) === true && H.state.steps === 1);
  T('remaining fell by exactly one', H.state.left === 6, H.state.left);
  T('over stays at zero', H.state.over === 0);
  T('undo takes the charge back', H.undoOnce() === 0 && H.state.state === H.state.start);
  T('undo of an empty history is refused', H.undoOnce() === 0);
  s = H.restart();
  T('restart returns a clean board', s === 0 && H.state.left === 7);
  const played = playRoute();
  await wait(() => H.state.done);
  s = H.state;
  T('the route solves the board', s.done === true && played === 7, played);
  T('steps equal the bound', s.steps === s.par, [s.steps, s.par]);
  T('graded as the certified solution', s.grade === 'certified' && s.cardTitle === '认证解', s.cardTitle);
  T('the win card opened', s.curtain === true);
  T('nothing is left and nothing is over', s.left === 0 && s.over === 0);
  T('the board accepts no further moves', H.move(0, 1) === false && H.state.steps === 7);
  const best = H.save().best['lot-3p-3'];
  T('the record was written', best === 7, best);
  H.closeCard();
  H.restart();
  H.move(0, 1); H.move(1, 0);
  playRoute();
  await wait(() => H.state.done);
  s = H.state;
  T('a wasted round trip costs two moves', s.steps === 9 && s.over === 2, [s.steps, s.over]);
  T('…and the card says the bound was missed', s.cardTitle === '已通关，但未达已证下界', s.cardTitle);
  T('…so it is not certified', s.grade !== 'certified' && ['clean', 'long'].includes(s.grade), s.grade);
  T('the record kept the better run', H.save().best['lot-3p-3'] === 7, H.save().best['lot-3p-3']);
${POSTLUDE}`,

  '@routes': `${PRELUDE}
  const cases = [['lot-3p-1', 1], ['lot-3p-2', 3], ['lot-3p-4', 15], ['lot-3p-7', 127], ['lot-3p-8', 255], ['lot-4p-4', 9], ['lot-4p-5', 13], ['lot-4p-8', 33]];
  for (const [id, par] of cases) {
    await load('#/lot/' + id);
    const r = H.route();
    T(id + ': route length is the printed par', r.length === par, [r.length, par]);
    playRoute();
    await wait(() => H.state.done);
    T(id + ': played to the goal in par', H.state.done && H.state.steps === par, [H.state.steps, par]);
    T(id + ': certified', H.state.grade === 'certified', H.state.grade);
    H.restart();
  }
  await load('#/lot/lot-3p-13');
  T('lot-3p-13: 8191 moves without searching at click time', H.route().length === 8191 && H.state.left === 8191, H.state.left);
  T('lot-3p-13: the board still reports its space', H.state.n === 13 && H.state.pegs === 3);
  await load('#/lot/lot-4p-10');
  T('lot-4p-10: the certified route is 49 moves', H.route().length === 49, H.route().length);
  T('lot-4p-10: exact is false, the browser will not search 1048576 states', H.state.exact === false);
  const onRoute = H.route();
  H.move(onRoute[0].from, onRoute[0].to);
  const off = H.legal().find((m) => !(m.disk === onRoute[1].disk && m.to === onRoute[1].to));
  H.move(off.from, off.to);
  T('lot-4p-10: leaving the route makes the distance unknown', H.state.left === null, H.state.left);
  T('lot-4p-10: the hint goes quiet rather than guessing', H.route().length === 0, H.route().length);
  T('lot-4p-10: over par still degrades to billed minus par', H.state.over === 0 && H.state.steps === 2, [H.state.over, H.state.steps]);
  await load('#/index');
  T('the index door renders every row', document.querySelectorAll('#indexList li').length === 32, document.querySelectorAll('#indexList li').length);
  T('the index announces the largest graph', document.getElementById('indexList').textContent.includes('1,594,323'));
  T('the index prints the Frame-Stewart range', document.getElementById('indexList').textContent.includes('49, 65, 81'));
  T('the index prints the 线柱 closed form range', document.getElementById('indexList').textContent.includes('2, 8, 26, 80, 242'));
  // The index used to rebuild an href out of the printed fields, which sent a 线柱 row to
  // lot-3p-N: the same six numbers on screen, a different graph and a different par behind them.
  const hrefs = [...document.querySelectorAll('#indexList a')].map((a) => a.getAttribute('href'));
  T('a 线柱 entry links to its own id, not to the free tower of its shape',
    hrefs.filter((h) => /^#\\/lot\\/lot-line-\\d+$/.test(h)).length === 10, hrefs.filter((h) => h.includes('line')));
  T('…and every entry is a real row of the table',
    hrefs.every((h) => H.table().some((r) => '#/lot/' + r.id === h)), hrefs.length);
  const rb = getComputedStyle(document.getElementById('routeBox')).display;
  const ix = getComputedStyle(document.getElementById('index')).display;
  T('the index door hides the board and shows the list', H.state.mode === 'index' && !H.state.id
    && rb === 'none' && ix !== 'none', [H.state.mode, H.state.id, rb, ix]);
  T('the hidden board takes no space either, so nothing can be pressed through it',
    document.getElementById('routeBox').hidden === true
    && document.getElementById('board').getClientRects().length === 0,
    document.getElementById('board').getClientRects().length);
  await load('#/random/linked/playtest');
  const a = H.state;
  await load('#/lot/lot-3p-2');
  await load('#/random/linked/playtest');
  const b = H.state;
  T('a shared random token is the same board', a.id === b.id && a.par === b.par, [a.id, a.par]);
  T('a random board is a scramble', H.level().kind === 'scramble', H.level().kind);
  // The variant has no scrambles to serve, so its random door picks one of the certified baked
  // towers. It must not throw, and it must not quietly re-band the request onto the free game.
  await load('#/random/line/playtest');
  const l1 = H.state;
  await load('#/lot/lot-3p-2');
  await load('#/random/line/playtest');
  const l2 = H.state;
  T('a 线柱 token is served a 线柱 board', l1.rule === 'line' && l1.tier === 'line', [l1.rule, l1.tier]);
  T('…the same token is the same board a second time', l1.id === l2.id && l1.par === l2.par, [l1.id, l2.id]);
  T('…a certified full tower, and exact at click time', l1.kind === 'canonical' && l1.exact === true, [l1.kind, l1.exact]);
  T('…with the variant named on the band chip', document.getElementById('band').textContent.includes('线柱'), document.getElementById('band').textContent);
  await load('#/daily');
  T('the daily door resolves', /^daily-\\d{4}-\\d{2}-\\d{2}$/.test(H.state.id), H.state.id);
  T('the daily par is a measured distance', H.state.par > 0 && H.state.left === H.state.par);
  await load('#/lot/no-such-lot');
  T('an unknown LOT falls back instead of dying', H.state.id === 'lot-3p-1', H.state.id);
  await load('#/lot/lot-3p-4');
  T('and the game keeps playing after the fallback', H.route().length === 15);
${POSTLUDE}`,

  '@save': `${PRELUDE}
  H.resetSave();
  T('reset reports success', H.selfTest().ok === true, JSON.stringify(H.selfTest()));
  T('a wiped save reads as a first visit', Object.keys(H.save().best).length === 0);
  await load('#/lot/lot-3p-2');
  playRoute();
  await wait(() => H.state.done);
  T('finishing writes a record', H.save().best['lot-3p-2'] === 3, H.save().best['lot-3p-2']);
  let st = H.saveStats();
  T('plays counted', st.plays === 1 && st.wins === 1, JSON.stringify(st));
  T('certified counted', st.certified === 1, st.certified);
  H.closeCard(); H.restart();
  H.move(0, 1); H.move(1, 0); H.move(0, 2); playRoute();
  await wait(() => H.state.done);
  st = H.saveStats();
  T('a worse run does not move the record', H.save().best['lot-3p-2'] === 3, H.save().best['lot-3p-2']);
  T('but it is still counted as a play', st.plays === 2 && st.wins === 2, JSON.stringify(st));
  T('and not as a certification', st.certified === 1, st.certified);
  T('the version stamp is 1', H.save().v === 1);
  T('updatedAt was stamped', H.save().updatedAt > 0);
  const today = document.getElementById('today').textContent;
  await load('#/daily');
  playRoute();
  await wait(() => H.state.done);
  T('the daily got its own line', Number.isSafeInteger(H.save().daily[today]), JSON.stringify(H.save().daily));
  T('daily keys are dates', /^\\d{4}-\\d{2}-\\d{2}$/.test(today), today);
  T('records are counted for the panel', H.saveStats().records >= 1, JSON.stringify(H.saveStats()));
  await load('#/lot/lot-3p-5');
  T('a never-played board shows no record', H.state.best === null);
  T('the panel prints 无 for it', document.getElementById('best').textContent === '无', document.getElementById('best').textContent);
  H.resetSave();
  T('reset really cleared the key', Object.keys(H.save().best).length === 0 && Object.keys(H.save().daily).length === 0);
${POSTLUDE}`,

  '@reloaded': `${PRELUDE}
  H.resetSave();
  await load('#/lot/lot-3p-6');
  playRoute();
  await wait(() => H.state.done);
  T('a run was recorded in this page life', H.save().best['lot-3p-6'] === 63, H.save().best['lot-3p-6']);
  T('with the counters behind it', H.saveStats().plays === 1, JSON.stringify(H.saveStats()));
${POSTLUDE}`,

}

// The reloaded scenario needs a second page life, so it is run in two driver passes by
// verify.sh; the tail below is the part that executes after the reload.
const RELOADED_TAIL = `(async () => {
  const H = window.hanoi;
  const rows = [];
  const T = (test, pass, detail) => rows.push({ test, pass: !!pass, detail: detail === undefined ? null : (typeof detail === 'object' ? JSON.stringify(detail) : String(detail)) });
  T('the shell came back up', !!H && !!H.state);
  const save = H.save();
  T('the save survived the reload', save.best['lot-3p-6'] === 63, JSON.stringify(save.best));
  T('counters survived too', H.saveStats().plays >= 1, JSON.stringify(H.saveStats()));
  H.load('#/lot/lot-3p-6');
  const wait = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = fn(); } catch (e) { v = false; } if (v || Date.now() - t0 > ms) return v; await new Promise((r) => setTimeout(r, 40)); } };
  await wait(() => H.state.id === 'lot-3p-6');
  T('the panel shows the stored record', H.state.best === 63 && document.getElementById('best').textContent === '63', [H.state.best, document.getElementById('best').textContent]);
  T('replaying the same board is still possible', H.route().length === 63, H.route().length);
  T('a finished board keeps its record after a reload', Object.keys(save.best).every((k) => Number.isSafeInteger(save.best[k]) && save.best[k] > 0));
  H.resetSave();
  return { rows, fail: rows.filter((r) => !r.pass).length };
})()`;

// ---- @pointer: a real finger through a whole certified solution ------------------------------
async function pointerScenario(cdp, sessionId, runJS, waitShell) {
  const rows = [];
  const T = (test, pass, detail) => {
    rows.push({ test, pass: !!pass, detail: detail === undefined ? null : JSON.stringify(detail) });
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${test}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  };
  const st = async () => runJS('window.hanoi.state');
  const dropPoint = async (peg) => runJS(`(() => {
    const H = window.hanoi, g = H.geom(), r = H.canvasRect();
    return [r.x + g.centers[${peg}], r.y + g.floor - g.diskH];
  })()`);
  const grabPoint = async (disk) => runJS(`window.hanoi.diskPoint(${disk})`).then((p) => [p.x, p.y]);
  // Ask the view whether anything is still in motion, instead of guessing how long to sleep. The
  // travel easing is 190 ms of *legitimate* frames (js/view.js `settle`/`isMoving`), so a frame
  // sampled inside that tail changes for a real reason — and under load the CDP round trips alone
  // straddle it. Rows that compare two fingerprints come through here first.
  const quiet = async (ms = 3000) => runJS(`(async () => {
    const v = window.hanoi.view, t0 = Date.now();
    const moving = () => v.travel.size > 0 || !!v.drag || !!v.shake || performance.now() < v.flashUntil;
    while (moving() && Date.now() - t0 < ${ms}) await new Promise((r) => setTimeout(r, 20));
    return { moving: moving(), waited: Date.now() - t0 };
  })()`);

  await runJS(`window.hanoi.load('#/lot/lot-3p-4')`);
  await waitShell(120);
  let s = await st();
  T('pointer suite opens the 15-move tower', s.par === 15 && s.steps === 0, [s.par, s.steps]);
  const rect = await runJS('window.hanoi.canvasRect()');
  T('the board is inside the window', rect.x >= 0 && rect.w > 320 && rect.x + rect.w <= 1000, [Math.round(rect.x), Math.round(rect.w)]);
  T('the page reports client-space grab points', (await grabPoint(0))[0] >= rect.x, await grabPoint(0));

  // Before any press: prove the point the page handed back lands on the board itself. Every
  // assertion below is worthless while something invisible is eating the pointerdowns — and one
  // was, until `.curtain[hidden] { display: none }` (css/game.css), because `display: grid` on
  // .curtain beat the UA's [hidden] default and left a fixed, inset:0, z-index:30 veil on screen.
  const hit = await runJS(`(() => {
    const p = window.hanoi.diskPoint(0);
    const e = document.elementFromPoint(p.x, p.y);
    return { id: e && e.id, tag: e && e.tagName, veil: getComputedStyle(document.getElementById('curtain')).display };
  })()`);
  T('the disk the mouse aims at is the element under that point', hit.id === 'board', hit);

  // A press on an empty peg: nothing to lift, so nothing is billed.
  const empty = await dropPoint(2);
  let before = await st();
  await dragAt(cdp, sessionId, runJS, [empty[0], empty[1] - 2], empty, 1, 40);
  s = await st();
  T('a press on an empty peg moves nothing', s.steps === before.steps && s.refused === before.refused + 1, [s.steps, s.refused]);

  // THE RULE UNDER A FINGER: lift the disk that is one size too large and drop it onto a peg
  // whose top disk is smaller. The drag is legal to start and illegal to finish, so it must be
  // refused AND NOT COUNTED. First put the smallest disk out on peg 2, by hand, with the mouse.
  const hop = await runJS(`(() => {
    const H = window.hanoi, g = H.geom(), r = H.canvasRect();
    const p = H.diskPoint(0);
    return { grab: [p.x, p.y], drop: [r.x + g.centers[2], r.y + g.floor - g.diskH] };
  })()`);
  before = await st();
  await dragAt(cdp, sessionId, runJS, hop.grab, hop.drop, 3, 25);
  s = await st();
  T('the smallest disk moved out under the mouse', s.steps === before.steps + 1 && s.digits[0] === 2, [s.steps, s.digits[0]]);
  const big = await grabPoint(1);
  const onto = await dropPoint(2);
  before = await st();
  await dragAt(cdp, sessionId, runJS, big, [onto[0], onto[1] - 8], 4, 30);
  s = await st();
  T('a larger disk onto a smaller one is refused', s.steps === before.steps, [s.steps, before.steps]);
  T('…and costs no count', s.refused === before.refused + 1 && s.state === before.state, [s.refused, s.state === before.state]);
  T('…and the position is untouched', s.digits[1] === 0 && s.digits[0] === 2, s.digits);

  // A drag that comes back to its own column is not a move either. (The gesture can only ever
  // lift the top disk of a peg, so a buried disk is unreachable by mouse — js/core/game.js still
  // refuses it through the programmatic door, which test/game.test.mjs covers.)
  const back = await grabPoint(1);
  before = await st();
  await dragAt(cdp, sessionId, runJS, back, [back[0], back[1] + 12], 3, 40);
  s = await st();
  T('a drag back onto its own peg is refused', s.steps === before.steps && s.refused === before.refused + 1, [s.steps, s.refused]);

  // Back to a clean tower so the border probes start from a known position (the refusals above
  // stay counted: restart clears the board, not the ledger).
  await runJS('window.hanoi.restart()');
  await waitShell(60);

  // Over-drag, clamped at both borders.
  const d0 = await grabPoint(0);
  const rightEdge = await runJS('window.hanoi.canvasRect().x + window.hanoi.canvasRect().w + 60');
  before = await st();
  await dragAt(cdp, sessionId, runJS, d0, [rightEdge, (await dropPoint(2))[1]], 5, 40);
  s = await st();
  T('a drag off the right border clamps to the last peg', s.steps === before.steps + 1 && s.digits[0] === s.pegs - 1, [s.steps, s.digits[0]]);
  const d1 = await grabPoint(0);
  const leftEdge = await runJS('Math.max(0, window.hanoi.canvasRect().x - 40)');
  before = await st();
  await dragAt(cdp, sessionId, runJS, d1, [leftEdge, (await dropPoint(0))[1]], 5, 40);
  s = await st();
  T('a drag off the left border clamps to the first peg', s.steps === before.steps + 1 && s.digits[0] === 0, [s.steps, s.digits[0]]);

  // The two border probes are real, billed moves, so the certified run below starts from a clean
  // counter. `reset` clears the position and the move count but not `refused` (js/core/game.js
  // `reset`), which is what lets the ledger rows above and the count row below both hold.
  await runJS('window.hanoi.restart()');
  await waitShell(60);

  // The whole certified solution, one real drag per move, coordinates read from the page each
  // time so the mouse is always where the board actually is.
  //
  // The drawing has to follow the maths, and `frames` alone cannot prove it: what froze was the
  // picture, not the counter. pixels() hashes the whole surface, and the row below is the control
  // that makes the row inside the loop mean something — two reads with no interaction in between
  // hash identically, so a changed hash is a real repaint and not sampling noise. That control is
  // only valid at rest, so the preceding row establishes rest from the view's own motion state:
  // the two border probes above billed real moves, and a disk in flight repaints for 190 ms.
  // A restart (or an undo) changes the truth underneath an in-flight animation, so the picture has
  // to snap with it — that is `js/view.js:snap`, and this is the row that keeps it. The move is
  // billed through the hook rather than the mouse on purpose: `commit()` arms `travel` with
  // t0 = now, so the row catches the animation while it is certainly still running.
  await runJS('window.hanoi.restart()');
  await runJS('window.hanoi.move(0, 1)');
  const armed = await runJS('window.hanoi.view.travel.size');
  await runJS('window.hanoi.restart()');
  const snapped = await runJS('window.hanoi.view.travel.size');
  T('a restart snaps an in-flight move instead of replaying it', armed === 1 && snapped === 0, [armed, snapped]);
  const rest = await quiet();
  T('nothing is in motion when the fingerprint control samples', rest.moving === false, rest);
  const stillA = await runJS('window.hanoi.pixels()');
  const stillB = await runJS('window.hanoi.pixels()');
  T('the frame fingerprint is stable while nothing happens', stillA === stillB, [stillA, stillB]);
  let billed = 0;
  let wrong = 0;
  let guard = 0;
  let repainted = null;
  while (!(await st()).done && guard++ < 40) {
    const plan = await runJS(`(() => {
      const H = window.hanoi, g = H.geom(), r = H.canvasRect();
      const mv = H.route()[0];
      if (!mv) return null;
      const p = H.diskPoint(mv.disk);
      return { grab: [p.x, p.y], drop: [r.x + g.centers[mv.to], r.y + g.floor - g.diskH], disk: mv.disk, to: mv.to };
    })()`);
    if (!plan) { wrong++; break; }
    const before = await st();
    const pxBefore = billed === 0 ? await runJS('window.hanoi.pixels()') : null;
    await dragAt(cdp, sessionId, runJS, plan.grab, plan.drop, 3, 22);
    const after = await st();
    if (billed === 0) repainted = (await runJS('window.hanoi.pixels()')) !== pxBefore;
    if (after.steps !== before.steps + 1) wrong++;
    if (after.digits[plan.disk] !== plan.to) wrong++;
    billed++;
  }
  s = await st();
  T('every real drag billed exactly one move', wrong === 0 && billed === 15, [billed, wrong]);
  T('the tower is finished under the mouse', s.done === true, s.done);
  T('steps equal the exhaustively measured par', s.steps === s.par, [s.steps, s.par]);
  T('the win card is the certified one', s.grade === 'certified' && s.curtain === true && s.cardTitle === '认证解', s.cardTitle);
  T('the pointer never inflated the counter', s.refused === 3, s.refused);
  const panelSteps = await runJS('document.getElementById("steps").textContent');
  T('the panel printed the same number as the maths', Number(panelSteps) === s.par, [panelSteps, s.par]);
  T('the canvas kept painting through the solution', s.frames > 60, s.frames);
  T('a billed drag repaints the board, not just the panel', repainted === true, repainted);

  await runJS(`window.hanoi.load('#/lot/lot-4p-5')`);
  await waitShell(120);
  // A finished tower opens the win card; opening the next chart must take that card out of the
  // way, or the next board is a fixed inset:0 veil that bills nothing to a real finger.
  const hit4 = await runJS(`(() => {
    const H = window.hanoi, p = H.diskPoint(0), e = document.elementFromPoint(p.x, p.y);
    const c = document.getElementById('curtain');
    return { id: e && e.id, hidden: c.hidden, veil: getComputedStyle(c).display };
  })()`);
  T('a fresh chart opens with the previous win card out of the way', hit4.id === 'board' && hit4.veil === 'none', hit4);
  const beforeFour = await st();
  const plan4 = await runJS(`(() => {
    const H = window.hanoi, g = H.geom(), r = H.canvasRect();
    const mv = H.route()[0];
    const p = H.diskPoint(mv.disk);
    return { grab: [p.x, p.y], drop: [r.x + g.centers[mv.to], r.y + g.floor - g.diskH] };
  })()`);
  await dragAt(cdp, sessionId, runJS, plan4.grab, plan4.drop, 3, 22);
  s = await st();
  T('a four-peg board takes a real drag too', s.steps === beforeFour.steps + 1 && s.pegs === 4, [s.steps, s.pegs]);
  T('and its bound is the Frame-Stewart value 13', s.par === 13, s.par);
  T('the hint line names a disk and two pegs', (await runJS('document.getElementById("hintline").textContent')).includes('号盘'));

  // A pump that redraws forever is as broken as one that never redraws: it pins a core and, under
  // headless Chrome, never lets the page go idle. Measure the quiet window only after the last
  // animation has expired — a disk in flight is 190 ms of legitimate frames, and sampling across
  // that tail reads a finished animation as a runaway loop.
  await runJS('new Promise((r) => setTimeout(r, 700))');
  const restA = (await st()).frames;
  await runJS('new Promise((r) => setTimeout(r, 900))');
  const restB = (await st()).frames;
  T('the repaint pump goes quiet at rest', restB === restA, [restA, restB]);
  return { rows, fail: rows.filter((r) => !r.pass).length };
}

// ---- @line: the 线柱 variant under a real finger --------------------------------------------
// The variant is one extra clause in `canMove`, which js/core/game.js and test/line.test.mjs prove
// over the whole 3^n graph. What only a browser can prove is the other half of the promise: that
// the shell routes `#/lot/lot-line-N` to the adjacency graph rather than to the free tower of the
// same shape, that the rail is painted so a refusal has a reason on screen, and that a finger
// dragging the smallest disk from the first peg to the last one is refused by the page — not just
// by a function nobody called.
async function lineScenario(cdp, sessionId, runJS, waitShell) {
  const rows = [];
  const T = (test, pass, detail) => {
    rows.push({ test, pass: !!pass, detail: detail === undefined ? null : JSON.stringify(detail) });
    console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${test}${detail !== undefined ? `  ${JSON.stringify(detail)}` : ''}`);
  };
  const st = async () => runJS('window.hanoi.state');
  const dropPoint = async (peg) => runJS(`(() => {
    const H = window.hanoi, g = H.geom(), r = H.canvasRect();
    return [r.x + g.centers[${peg}], r.y + g.floor - g.diskH];
  })()`);
  const grabPoint = async (disk) => runJS(`window.hanoi.diskPoint(${disk})`).then((p) => [p.x, p.y]);
  // A vertical slice of the rail the view draws between neighbouring pegs, read straight off the
  // canvas: `geom()` hands back the same local CSS pixels the drawing used, so this samples the
  // line the player sees instead of hashing the whole picture and hoping. The threshold is the
  // rail's own colour arithmetic — rgba(150,163,182,.42) over the #2a2f3a base beam composites to
  // about (87,96,110), while the beam itself stays under (60,66,80) — so what this counts is the
  // link, not the board it is drawn on.
  const railInk = () => runJS(`(() => {
    const H = window.hanoi, c = document.getElementById('board'), g = H.geom();
    const ctx = c.getContext('2d');
    const dpr = c.width / g.w;
    const y = Math.round((g.floor + Math.max(5, g.h * 0.015)) * dpr);
    const mid = Math.round(((g.centers[0] + g.centers[1]) / 2) * dpr);
    const d = ctx.getImageData(mid - 4, y - 4, 9, 9).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 72 && d[i + 2] > 88) ink++;
    return ink;
  })()`);

  await runJS(`window.hanoi.load('#/lot/lot-line-4')`);
  await waitShell(120);
  let s = await st();
  T('the 线柱 chart opens on the adjacency graph', s.rule === 'line' && s.par === 80 && s.n === 4, [s.rule, s.par, s.n]);
  T('…and not on the free tower that shares its shape', s.par !== 15 && s.left === 80, [s.par, s.left]);
  const panel = await runJS('[document.getElementById("shape").textContent, document.getElementById("band").textContent, document.getElementById("ways").textContent]');
  T('the panel says 仅相邻 and names the 线柱 band', panel[0].includes('仅相邻') && panel[1].includes('线柱'), panel);
  T('…while the route count stays the measured one', panel[2].includes('1 条'), panel[2]);
  const inkLine = await railInk();
  await runJS(`window.hanoi.load('#/lot/lot-3p-4')`);
  await waitShell(120);
  const inkFree = await railInk();
  T('the rail is painted between neighbouring pegs', inkLine > 8, inkLine);
  T('…and the published game draws no such link', inkFree === 0, inkFree);

  await runJS(`window.hanoi.load('#/lot/lot-line-4')`);
  await waitShell(120);

  // THE ADJACENCY UNDER A FINGER: the smallest disk, legal to lift, dropped two pegs away.
  const before = await st();
  const far = await runJS(`(() => {
    const H = window.hanoi, g = H.geom(), r = H.canvasRect();
    const p = H.diskPoint(0);
    return { grab: [p.x, p.y], drop: [r.x + g.centers[2], r.y + g.floor - g.diskH] };
  })()`);
  await dragAt(cdp, sessionId, runJS, far.grab, far.drop, 5, 25);
  s = await st();
  T('a corner-to-corner drag is refused', s.steps === before.steps && s.state === before.state, [s.steps, s.state]);
  T('…it is counted as a refusal, not as a move', s.refused === before.refused + 1, [s.refused, before.refused]);
  const reason = await runJS('window.hanoi.toastText()');
  T('…and the page says which half of the rule said no', reason.includes('相邻'), reason);

  // The same disk, one peg over: accepted and billed.
  const near = await runJS(`(() => {
    const H = window.hanoi, g = H.geom(), r = H.canvasRect();
    const p = H.diskPoint(0);
    return { grab: [p.x, p.y], drop: [r.x + g.centers[1], r.y + g.floor - g.diskH] };
  })()`);
  const preHop = await st();
  await dragAt(cdp, sessionId, runJS, near.grab, near.drop, 4, 25);
  s = await st();
  T('the neighbouring peg takes the same drag', s.steps === preHop.steps + 1 && s.digits[0] === 1, [s.steps, s.digits[0]]);
  T('…and the distance fell by exactly one', s.left === preHop.left - 1, [s.left, preHop.left]);
  await runJS('window.hanoi.restart()');
  await waitShell(60);

  // The rule the page reports is the rule the page plays by.
  const legal = await runJS('window.hanoi.legal()');
  T('every move the page calls legal steps one peg', legal.every((m) => Math.abs(m.to - m.from) === 1), legal);
  T('…and on the first tower that is exactly one move', legal.length === 1, legal.length);

  // The whole certified solution, one real drag per move, on a 26-move 线柱 tower.
  await runJS(`window.hanoi.load('#/lot/lot-line-3')`);
  await waitShell(120);
  const preRun = await st();
  T('the 26-move tower opens with the measured par', preRun.par === 26 && preRun.steps === 0, [preRun.par, preRun.steps]);
  let billed = 0;
  let wrong = 0;
  let refusedByUs = 0;
  let guard = 0;
  while (!(await st()).done && guard++ < 40) {
    const plan = await runJS(`(() => {
      const H = window.hanoi, g = H.geom(), r = H.canvasRect();
      const mv = H.route()[0];
      if (!mv) return null;
      const p = H.diskPoint(mv.disk);
      return { grab: [p.x, p.y], drop: [r.x + g.centers[mv.to], r.y + g.floor - g.diskH], disk: mv.disk, to: mv.to, from: mv.from };
    })()`);
    if (!plan) { wrong++; break; }
    if (Math.abs(plan.to - plan.from) !== 1) wrong++;
    const b = await st();
    const r0 = b.refused;
    await dragAt(cdp, sessionId, runJS, plan.grab, plan.drop, 3, 20);
    const a = await st();
    if (a.steps !== b.steps + 1) wrong++;
    if (a.digits[plan.disk] !== plan.to) wrong++;
    if (a.refused !== r0) refusedByUs++;
    billed++;
  }
  s = await st();
  T('every certified 线柱 drag billed exactly one move', wrong === 0 && billed === 26, [billed, wrong]);
  T('…and none of them was refused', refusedByUs === 0, refusedByUs);
  T('the tower is finished under the mouse', s.done === true && s.steps === s.par, [s.done, s.steps, s.par]);
  T('…and certified against the exhaustively measured bound', s.grade === 'certified' && s.cardTitle === '认证解', [s.grade, s.cardTitle]);
  T('the record book took the 线柱 id', s.best === 26, s.best);
  const space = await runJS('document.getElementById("space").textContent');
  T('the panel still prints the state space it was swept over', space.includes('3^3 = 27'), space);
  await runJS('new Promise((r) => setTimeout(r, 700))');
  const restA = (await st()).frames;
  await runJS('new Promise((r) => setTimeout(r, 900))');
  T('the repaint pump goes quiet at rest', (await st()).frames === restA, [restA, (await st()).frames]);
  return { rows, fail: rows.filter((r) => !r.pass).length };
}

// ---- driver ---------------------------------------------------------------------------------
async function main() {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const cdp = new CDP(ws);
  let list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  if (cmd === 'open') {
    for (const t of list) if (t.type === 'page' && isOurs(t.url)) {
      try { await cdp.send('Target.closeTarget', { targetId: t.id || t.targetId }); } catch { /* already gone */ }
    }
    await sleep(300);
    list = [];
  }
  const existing = cmd === 'open' ? null : list.find((t) => t.type === 'page' && isOurs(t.url));
  let targetId, sessionId;
  if (existing) {
    targetId = existing.id || existing.targetId;
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  } else {
    ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }));
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
  }
  const logs = [];
  globalThis.__printEvents = (m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map((a) => (a.value !== undefined ? String(a.value) : (a.description || a.type))).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      const e = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${e.exception?.description || e.text}\n  at ${e.url}:${e.lineNumber}`);
    } else if (m.method === 'Log.entryAdded') {
      const e = m.params.entry;
      if (e.level === 'error' || e.source === 'rendering') logs.push(`[log:${e.level}] ${e.text} ${e.url || ''}`);
    }
  };
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);

  const runJS = async (expression) => {
    const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  // The page is a module graph over the network, so wait for the shell rather than for a fixed
  // number of milliseconds: a slow origin (GitHub Pages) must not look broken, a fast one
  // (localhost) must not be slowed down by a guess.
  const waitShell = async (floorMs = 500, budgetMs = SHELL_TIMEOUT) => {
    await sleep(floorMs);
    const deadline = Date.now() + budgetMs;
    for (;;) {
      let ready = false;
      try {
        ready = await runJS('!!(window.hanoi && window.hanoi.state && (window.hanoi.state.id || window.hanoi.state.mode === "index"))');
      } catch { ready = false; }
      if (ready) return true;
      if (Date.now() > deadline) return false;
      await sleep(150);
    }
  };

  // The scenario answer is one `RESULT ` line so tools/verify.sh can slice it out of a stdout that
  // also carries progress lines. The collected page console goes out under it, because a warning
  // the gate cannot grep for is a warning the gate never fails on.
  const emitResult = (obj) => {
    console.log('RESULT ' + JSON.stringify(obj));
    if (obj.console) console.log(logs.join('\n'));
  };

  if (cmd === 'open') {
    await cdp.send('Page.navigate', { url: arg || BASE }, sessionId);
    await waitShell(600);
    console.log('opened ' + (arg || BASE) + '\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'nav') {
    await cdp.send('Page.navigate', { url: arg }, sessionId);
    await waitShell(400);
    console.log('navigated\n' + (logs.join('\n') || '(no console output)'));
  } else if (cmd === 'drag') {
    if (!(await waitShell(60))) { console.log('SHELL NOT READY'); process.exit(1); }
    const spec = JSON.parse(arg);
    await dragAt(cdp, sessionId, runJS, spec.from, spec.to, spec.steps || 4, spec.hold || 40);
    console.log(JSON.stringify(await runJS('window.hanoi.state')));
  } else if (cmd === 'shot') {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    writeFileSync(arg, Buffer.from(data, 'base64'));
    console.log('wrote ' + arg);
  } else if (cmd === 'logs') {
    // Log.enable replays the page's buffered entries, and the replay arrives after the command
    // reply — printing immediately would report "no console output" for a page that warned.
    await sleep(400);
    console.log(logs.join('\n') || '(no console output)');
  } else if (cmd === 'eval') {
    const noNav = process.argv[4] === 'nonav';
    const boot = async () => {
      if (noNav) return waitShell(60);
      await cdp.send('Page.navigate', { url: BASE }, sessionId);
      return waitShell(400);
    };
    if (!String(arg).startsWith('@')) {
      if (!(await boot())) { console.log('SHELL NOT READY'); process.exit(1); }
      console.log(JSON.stringify(await runJS(arg)));
      ws.close();
      return;
    }
    if (arg === '@pointer') {
      if (!(await boot())) { console.log('RESULT {"rows":[],"fail":1,"console":0,"note":"shell never appeared"}'); process.exit(1); }
      emitResult({ ...(await pointerScenario(cdp, sessionId, runJS, waitShell)), console: logs.length });
      ws.close();
      return;
    }
    if (arg === '@line') {
      if (!(await boot())) { console.log('RESULT {"rows":[],"fail":1,"console":0,"note":"shell never appeared"}'); process.exit(1); }
      emitResult({ ...(await lineScenario(cdp, sessionId, runJS, waitShell)), console: logs.length });
      ws.close();
      return;
    }
    if (arg === '@reloaded') {
      // Two page lives in one command: record, then really reload the document and read the
      // save back off the disk. A page that only remembers things in memory is not saved.
      if (!(await boot())) { console.log('RESULT {"rows":[],"fail":1,"console":0,"note":"shell never appeared"}'); process.exit(1); }
      let first = { rows: [], fail: 0 };
      try {
        first = await runJS(SCENARIOS['@reloaded']);
      } catch (e) {
        // Swallowing this would report a nine-row suite built only from the second page life.
        first = { rows: [{ test: '@reloaded pass 1 threw', pass: false, detail: String(e.message).slice(0, 300) }], fail: 1 };
      }
      await cdp.send('Page.reload', { ignoreCache: true }, sessionId);
      if (!(await waitShell(300))) { console.log('RESULT {"rows":[],"fail":1,"console":0,"note":"reload never came back"}'); process.exit(1); }
      const second = await runJS(RELOADED_TAIL);
      const rows = [...(first.rows || []), ...(second.rows || [])];
      emitResult({ rows, fail: rows.filter((r) => !r.pass).length, console: logs.length });
      ws.close();
      return;
    }
    const body = String(arg).startsWith('@') ? SCENARIOS[arg] : arg;
    if (!body) { console.log('unknown scenario or empty expression: ' + arg); process.exit(1); }
    if (!(await boot())) { console.log('RESULT {"rows":[],"fail":1,"console":0,"note":"shell not ready"}'); process.exit(1); }
    emitResult({ ...(await runJS(body)), console: logs.length });
    ws.close();
    return;
  } else {
    console.log('unknown command ' + cmd);
    process.exit(1);
  }
  ws.close();
}

main().catch((e) => {
  console.error('PLAYTEST ERROR', e && e.message ? e.message : e);
  process.exit(1);
});
