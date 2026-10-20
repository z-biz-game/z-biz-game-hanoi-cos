// Pixels and gestures only. This file reads the game state, never decides anything about it: a
// drag becomes exactly one `onMove(from, to)` call, and whether that move is legal, billed and
// closer to the goal is js/core/game.js's business alone. That is also why an automated finger
// and a human one are indistinguishable to the tests — both end up at `moveTop`.
//
// Two places would like to *predict* that verdict so the player can see it before committing: the
// drag ghost's green/red outline, and the link glyphs drawn between pegs on a 线柱 board. Both
// read the same `legalMoves(state, n, pegs, rule)` the rule predicate exports, with the game's own
// `rule` passed through — a highlight computed under `'free'` over a board played under `'line'`
// would advertise a move the core is about to refuse.
//
// Drawing is procedural geometry over a bitmap skin: pegs are tapered rectangles with a highlight,
// disks are rounded bars whose width is linear in diameter (game.js `diskWidth`), the whole board
// is scaled by the device pixel ratio, and the base beam / stage ground come from the tileable
// stone texture that assets/gen/make_art.py produces (js/skins.js). No fonts fetched, no audio
// files — the sounds are synthesised in js/audio.js.
//
// Time is *not* read from the wall clock any more. The pump integrates a frame delta into
// `view.clock` and every animation is expressed against that clock, which buys three things the
// previous `performance.now()` reads could not:
//   1) 暂停真的冻住画面 —— 冻结的是累加器，不是把某处判断改成 false；恢复时不追帧；
//   2) 30/60/120 Hz 下同一虚拟时长画出同一张图（§帧率对拍要的就是这个可比性）；
//   3) prefers-reduced-motion 有一个真分支：动画时长取 0，而不是"少动一点"。

import { DEFAULT_RULE, diskWidth, pegTops, decode, pegOf, legalMoves } from './core/game.js';
import { createSkins } from './skins.js';

const PEG_NAMES = ['甲', '乙', '丙', '丁'];

// Animation durations, in seconds of *view clock*. Kept next to the clock they are measured in.
const TRAVEL_S = 0.19;
const SHAKE_S = 0.26;
const FLASH_S = 0.42;
const MAX_DT = 0.25;          // 一帧最多算 250ms：标签页回来不补画历史
export const DEMO_STEP_S = 0.26;
// 拇指口径：画布上的盘也要有 44 CSS px 的可命中带，否则 9px 高的盘在手机上只能靠运气。
export const HIT_MIN = 44;

export function createView(canvas, hooks = {}) {
  // willReadFrequently is not a micro-optimisation here: pixels() reads the whole surface back to
  // fingerprint a frame, and without this hint Chrome books it as a GPU→CPU copy per call and
  // prints a console warning — and a dirty console is a red gate (tools/verify.sh).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const skins = createSkins(() => {
    // 位图到位只重画一帧。装载不是动画，所以 isMoving() 不受它影响 —— 静止指纹对照那条断言
    // 因此在图片到达前后都成立。
    draw();
  });
  const view = {
    game: null,
    painted: false,
    frames: 0,
    pending: 0,          // the rAF id settle() scheduled, or 0 when nothing is in flight
    dpr: 1,
    w: 0,
    h: 0,
    drag: null,          // { disk, from, x, y, target }
    travel: new Map(),   // disk -> { from, to, t0 }   t0 在 view.clock 的时间轴上
    shake: null,         // { peg, t0 }                同上
    hintOn: true,
    flashUntil: 0,       // 同上：clock 空间的截止时刻
    lastRoute: -1,
    clock: 0,            // 秒。只有未暂停且真的过了帧才前进
    last: 0,             // 上一帧的 wall timestamp，0 = 还没有上一帧（首帧 dt 记 0）
    paused: false,
    reducedMotion: false,
    keepAlive: false,    // 演示在跑：没有动画也要继续出帧
    subs: [],            // 帧订阅者（main.js 用它按 clock 驱动演示）
  };

  const emit = (name, arg) => {
    if (typeof hooks[name] === 'function') return hooks[name](arg);
    return undefined;
  };

  function measure() {
    const parent = canvas.parentElement || document.body;
    const rect = parent.getBoundingClientRect();
    const cssW = Math.max(320, Math.floor(rect.width - 8));
    const cssH = Math.max(220, Math.floor(Math.min(rect.height - 8, cssW * 0.62, 520)));
    view.dpr = Math.max(1, Math.min(3, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    canvas.width = Math.floor(cssW * view.dpr);
    canvas.height = Math.floor(cssH * view.dpr);
    view.w = cssW;
    view.h = cssH;
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    draw();
  }

  // Geometry, in CSS pixels, shared by the drawing and by the tests' automated finger.
  function geom() {
    const pegs = view.game ? view.game.pegs : 3;
    const n = view.game ? view.game.n : 4;
    // The rule travels with the geometry so every drawing and hit-test below reads one value;
    // `(view.game && view.game.rule) || DEFAULT_RULE` rather than `view.game.rule` because a
    // hand-built game in a test may not carry the field, and `null` would reach pegStepOk as an
    // unknown rule instead of as the published default.
    const rule = (view.game && view.game.rule) || DEFAULT_RULE;
    const pad = Math.max(14, view.w * 0.05);
    const usable = view.w - pad * 2;
    const slot = usable / pegs;
    const floor = view.h - Math.max(30, view.h * 0.12);
    const headroom = Math.max(46, view.h * 0.16);
    const stack = floor - headroom;
    const diskH = Math.max(9, Math.min(26, (stack * 0.82) / Math.max(4, Math.min(n, 9))));
    const maxHalf = slot * 0.44;
    return { pegs, n, rule, pad, usable, slot, floor, diskH, maxHalf, center: (p) => pad + slot * (p + 0.5), topOf: (k) => floor - diskH * 0.6 - k * diskH };
  }

  // Client-space helpers: the maths above is in canvas-local CSS pixels, but a real mouse event
  // (and therefore CDP's Input.dispatchMouseEvent) is in viewport coordinates. These two add the
  // offset so a test can press what the page reports, instead of guessing where the canvas is.
  function client(x, y) {
    const rect = canvas.getBoundingClientRect();
    return { x: rect.left + x, y: rect.top + y, rect };
  }

  // Which row of its peg a disk sits on, counted up from the floor. The floor row belongs to the
  // disk with everything else on top of it, so the count is of the disks *underneath* — the ones
  // with a higher index (index grows with diameter: game.js `diskWidth`, and `canMove` only lets a
  // disk land on a peg whose top is a larger index). Counting the smaller disks instead yields an
  // upside-down tower: the widest bar on the topmost row, the narrowest on the floor, and the
  // picture then claims the wrong disk is the liftable one.
  function slotOf(digits, disk, peg) {
    let k = 0;
    for (let i = disk + 1; i < digits.length; i++) if (digits[i] === peg) k++;
    return k;
  }

  function diskPoint(disk) {
    const g = geom();
    const s = view.game ? view.game.state : 0;
    const peg = view.game ? pegOf(s, disk, g.pegs) : 0;
    const digits = view.game ? decode(s, g.n, g.pegs) : [];
    const slot = slotOf(digits, disk, peg);
    const p = client(g.center(peg), g.topOf(slot));
    return { x: p.x, y: p.y, peg, slot, diskH: g.diskH };
  }

  function pegPoint(peg, slot = 0) {
    const g = geom();
    const p = client(g.center(peg), g.topOf(slot));
    return { x: p.x, y: p.y };
  }

  function pegAt(x) {
    const g = geom();
    // Clamped at both borders: dragging past the edge of the board selects the outermost peg
    // rather than nothing, which is what a player means and what the border test asserts.
    const raw = Math.floor((x - g.pad) / g.slot);
    return Math.max(0, Math.min(g.pegs - 1, raw));
  }

  function diskAt(x, y) {
    const g = geom();
    const peg = pegAt(x);
    const s = view.game.state;
    const digits = decode(s, g.n, g.pegs);
    let count = -1;
    for (let d = 0; d < g.n; d++) if (digits[d] === peg) count = Math.max(count, 0);
    if (count < 0) return -1; // empty peg
    const top = pegTops(s, g.n, g.pegs)[peg];
    const slots = slotOf(digits, top, peg);
    const py = g.topOf(slots);
    // 命中带取 diskH*1.9 与 HIT_MIN 的较大者：小屏上 diskH 只有 9px，按 1.9 倍算下来的
    // 17px 带在手机上基本按不中，而按到柱身时旧代码回的是「这柱是空的」——一句假话。
    if (y > py + Math.max(g.diskH * 1.9, HIT_MIN)) return -1; // 带外：真的是柱身/地面
    return top;
  }

  // ---- drawing ----------------------------------------------------------------------------
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function hue(disk, n) {
    // Warm brass to deep teal across the stack; the smallest disk is always the brightest, so
    // "which one is on top" is readable without counting.
    return 34 + (disk / Math.max(1, n - 1)) * 150;
  }

  // The rail itself. Legality is read from `legalMoves(state, n, pegs, rule)` — the same call the
  // ghost outline below uses and the same predicate the core bills against — so a segment can
  // never glow green on a move the game is about to refuse.
  function drawLinks(g) {
    const s = view.game.state;
    const y = g.floor + Math.max(5, view.h * 0.015);
    const d = view.drag;
    const over = d && Math.abs(d.target - d.from) === 1
      ? legalMoves(s, g.n, g.pegs, g.rule).some((m) => m.disk === d.disk && m.from === d.from && m.to === d.target)
      : null;
    const pair = d && Math.abs(d.target - d.from) === 1 ? [Math.min(d.from, d.target), Math.max(d.from, d.target)] : null;
    ctx.save();
    ctx.lineCap = 'round';
    for (let p = 0; p + 1 < g.pegs; p++) {
      const lit = pair && pair[0] === p && pair[1] === p + 1;
      ctx.strokeStyle = lit ? (over ? 'rgba(120,220,170,0.95)' : 'rgba(230,120,110,0.9)') : 'rgba(150,163,182,0.42)';
      ctx.lineWidth = lit ? 4 : 2.5;
      ctx.beginPath();
      ctx.moveTo(g.center(p) + 7, y);
      ctx.lineTo(g.center(p + 1) - 7, y);
      ctx.stroke();
      ctx.fillStyle = lit ? ctx.strokeStyle : 'rgba(150,163,182,0.42)';
      for (const cx of [g.center(p) + 7, g.center(p + 1) - 7]) {
        ctx.beginPath();
        ctx.arc(cx, y, lit ? 3 : 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  // The ground and the beam are the two places a procedural gradient reads as "a web page". The
  // stone skin is a tileable bitmap from make_art.py; when it has not arrived (or is unavailable)
  // the same shapes are filled with the old gradients, so a missing file costs texture, not board.
  function drawGround(g) {
    const sky = ctx.createLinearGradient(0, 0, 0, view.h);
    sky.addColorStop(0, '#181b22');
    sky.addColorStop(1, '#0f1116');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, view.w, view.h);

    const stone = skins.pattern(ctx, 'stone');
    if (stone) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = stone;
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.restore();
    }
    const grain = skins.pattern(ctx, 'grain');
    if (grain) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = grain;
      ctx.fillRect(0, 0, view.w, view.h);
      ctx.restore();
    }

    const beamH = Math.max(10, view.h * 0.03);
    ctx.fillStyle = stone || '#2a2f3a';
    roundRect(g.pad * 0.4, g.floor, g.usable + g.pad * 1.2, beamH, 6);
    ctx.fill();
    if (stone) {
      // 石材平铺时亮度由纹理自己决定，压一层深色保证顶沿读得出来
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#2a2f3a';
      ctx.fill();
      ctx.restore();
    }
    ctx.fillStyle = '#3b4250';
    roundRect(g.pad * 0.4, g.floor, g.usable + g.pad * 1.2, 4, 2);
    ctx.fill();
  }

  function draw() {
    const g = geom();
    const now = view.clock;
    ctx.clearRect(0, 0, g.pad * 2 + g.usable, view.h + 4);
    drawGround(g);

    // The 线柱 rail: a segment between every pair of neighbouring pegs and nothing else. A peg
    // pair with no segment in front of the finger is the restriction drawn, rather than a rule
    // the player has to remember.
    if (view.game && g.rule === 'line') drawLinks(g);

    for (let p = 0; p < g.pegs; p++) {
      const cx = g.center(p);
      const e = view.shake && view.shake.peg === p ? now - view.shake.t0 : -1;
      const shake = e >= 0 && e < SHAKE_S
        ? Math.sin(e / 0.022) * 3 * Math.max(0, 1 - e / SHAKE_S)
        : 0;
      ctx.save();
      ctx.translate(shake, 0);
      const post = ctx.createLinearGradient(cx - 6, 0, cx + 6, 0);
      post.addColorStop(0, '#4a4238');
      post.addColorStop(0.5, '#7a6c58');
      post.addColorStop(1, '#3b352d');
      ctx.fillStyle = post;
      roundRect(cx - 5, g.topOf(g.n - 1) - g.diskH * 0.4, 10, g.floor - g.topOf(g.n - 1) + g.diskH * 0.4, 4);
      ctx.fill();
      ctx.fillStyle = '#5d6675';
      ctx.font = `${Math.max(11, g.diskH * 0.75)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(PEG_NAMES[p], cx, g.floor + Math.max(22, view.h * 0.055));
      ctx.restore();
    }

    if (!view.game) {
      view.painted = true;
      return;
    }

    const hint = view.hintOn ? emit('hint') : null;
    const s = view.game.state;
    const digits = decode(s, g.n, g.pegs);

    // The rule made visible: for each peg, note the disk resting on a smaller one is impossible,
    // so what is drawn is always a decreasing stack.
    for (let d = g.n - 1; d >= 0; d--) {
      if (view.drag && view.drag.disk === d) continue;
      const trav = view.travel.get(d);
      let peg = digits[d];
      let lift = 0;
      if (trav) {
        // reduceMotion 走的是"时长为 0"这一支：盘直接出现在目的柱上，不是把缓动换个曲线。
        const t = view.reducedMotion ? 1 : Math.min(1, (now - trav.t0) / TRAVEL_S);
        if (t >= 1) view.travel.delete(d);
        peg = t < 0.5 ? trav.from : trav.to;
        lift = Math.sin(Math.PI * t) * g.diskH * 0.8;
      }
      const slots = slotOf(digits, d, peg);
      const w = diskWidth(d, g.n) * g.maxHalf * 2;
      const x = g.center(peg);
      const y = g.topOf(slots) - lift;
      drawDisk(d, g.n, x, y, w, g.diskH, hint && hint.disk === d, 1);
    }

    if (view.drag) {
      const d = view.drag.disk;
      const w = diskWidth(d, g.n) * g.maxHalf * 2;
      drawDisk(d, g.n, view.drag.x, view.drag.y, w, g.diskH, false, 0.94);
      // Ghost the candidate destination so an illegal target is obvious before the finger lifts.
      const tp = view.drag.target;
      const okTarget = legalMoves(s, g.n, g.pegs, g.rule).some((m) => m.disk === d && m.to === tp);
      ctx.strokeStyle = okTarget ? 'rgba(120,220,170,0.75)' : 'rgba(230,120,110,0.7)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 4]);
      roundRect(g.center(tp) - w / 2 - 3, g.topOf(0) - g.diskH * (g.n + 0.6), w + 6, g.diskH * (g.n + 0.6), 6);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (now < view.flashUntil) {
      const left = (view.flashUntil - now) / FLASH_S;
      ctx.fillStyle = `rgba(255,236,190,${0.16 * Math.max(0, Math.min(1, left))})`;
      ctx.fillRect(0, 0, view.w, view.h);
    }

    view.painted = true;
    if (view.shake && now - view.shake.t0 > SHAKE_S) view.shake = null;
  }

  function drawDisk(d, n, x, y, w, h, glowing, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const tint = hue(d, n);
    const face = ctx.createLinearGradient(x, y - h, x, y);
    face.addColorStop(0, `hsl(${tint} 62% 62%)`);
    face.addColorStop(1, `hsl(${tint} 55% 38%)`);
    ctx.fillStyle = face;
    roundRect(x - w / 2, y - h, w, h, Math.min(6, h * 0.45));
    ctx.fill();
    ctx.strokeStyle = glowing ? 'rgba(255,240,200,0.95)' : `hsla(${tint} 40% 18% / 0.85)`;
    ctx.lineWidth = glowing ? 2.5 : 1;
    ctx.stroke();
    if (glowing) {
      // 提示高亮的晕：有 sprite 就画 sprite（一次 drawImage，没有 shadowBlur 的逐帧开销），
      // 没有就退回原来的 shadowBlur 描边。reduceMotion 只关掉晕动的部分，边框留着 —— 提示
      // 本身是信息，不是装饰。
      const painted = view.reducedMotion ? false : skins.glow(ctx, x, y - h / 2, w * 1.9, h * 4.6, 0.9);
      if (!painted) {
        ctx.shadowColor = 'rgba(255,230,160,0.9)';
        ctx.shadowBlur = 12;
        ctx.strokeStyle = 'rgba(255,240,200,0.6)';
        roundRect(x - w / 2 - 2, y - h - 2, w + 4, h + 4, Math.min(8, h * 0.5));
        ctx.stroke();
        ctx.shadowBlur = 0;
      }
    }
    if (w > 26 && h > 11) {
      ctx.fillStyle = 'rgba(15,16,20,0.72)';
      ctx.font = `${Math.max(9, h * 0.62)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(d + 1), x, y - h * 0.3);
    }
    ctx.restore();
  }

  // 还在动的东西：飞行中的盘、柱身抖动、认证解的闪、被按住拖的盘。暂停不算"没在动"——
  // 暂停时冻住的是时钟，画面停在暂停那一帧上，正是它该有的样子。
  function isMoving() {
    return view.travel.size > 0 || !!view.drag || !!view.shake || view.clock < view.flashUntil;
  }

  // ---- the pump ---------------------------------------------------------------------------
  // Integrate one frame. `ts` is a rAF timestamp (ms); the first frame after a (re)start records
  // the stamp and advances nothing, so a pause or a tab-return cannot manufacture a long frame.
  function tick(ts) {
    const now = Number.isFinite(ts) && ts > 0 ? ts : wall();
    if (!view.last) {
      view.last = now;
      return 0;
    }
    let dt = (now - view.last) / 1000;
    view.last = now;
    if (!(dt > 0)) return 0;
    if (dt > MAX_DT) dt = MAX_DT;
    if (view.paused) return 0;      // 暂停：时钟不前进，动画与演示一起冻住
    view.clock += dt;
    return dt;
  }

  function wall() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  function drawFrame() {
    view.frames++;
    draw();
  }

  function frame(ts) {
    view.pending = 0;
    const dt = tick(ts);
    for (const cb of view.subs.slice()) cb(dt, view.clock);
    drawFrame();
    if (isMoving() || view.keepAlive) schedule();
  }

  function schedule() {
    if (view.pending || typeof requestAnimationFrame !== 'function') return;
    view.pending = requestAnimationFrame(frame);
  }

  // The only pump this view has: it paints immediately (so a caller reading the frame fingerprint
  // right after a gesture sees the new picture, not the pre-gesture one) and then keeps painting
  // one frame per rAF while something is in motion or the demo is running. Drawing is
  // unconditional because the *game* can change without anything being in motion (undo, restart,
  // a programmatic move).
  function settle() {
    drawFrame();
    if (isMoving() || view.keepAlive) schedule();
  }

  // ---- gestures ---------------------------------------------------------------------------
  // 画布坐标必须按 CSS 缩放换算：canvas.width 是 dpr 像素，而事件给的是视口 CSS 像素，
  // 两者都相对 getBoundingClientRect 的左上角，所以减完就是 CSS 空间，不必再乘 dpr。
  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, rect };
  }

  function down(ev) {
    if (!view.game || view.game.done) return;
    if (view.paused) { emit('paused-input'); return; }   // 暂停期间盘面不接受搬运
    const { x, y } = localPoint(ev);
    const disk = diskAt(x, y);
    if (disk < 0) {
      const peg = pegAt(x);
      const loaded = pegTops(view.game.state, view.game.n, view.game.pegs)[peg] >= 0;
      view.shake = { peg, t0: view.clock };
      // The peg travels with the reason: a press on an empty column never reaches `moveTop`, so
      // this hook is the only place that can tell the shell which column stayed blank.
      emit('refuse', { reason: loaded ? 'shaft' : 'nothing to lift', peg });
      settle();
      ev.preventDefault();
      return;
    }
    view.drag = { disk, from: pegOf(view.game.state, disk, view.game.pegs), x, y, target: pegOf(view.game.state, disk, view.game.pegs) };
    // 拿起的声音发在手势上，不发在结算上：这一盘可能马上被规则拒掉，玩家也得先听见手里有东西。
    emit('lift', { disk, from: view.drag.from });
    canvas.setPointerCapture && canvas.setPointerCapture(ev.pointerId);
    settle();
    ev.preventDefault();
  }

  function move(ev) {
    if (!view.drag) return;
    const { x, y } = localPoint(ev);
    view.drag.x = x;
    view.drag.y = y;
    view.drag.target = pegAt(x);
    settle();
    ev.preventDefault();
  }

  function up() {
    if (!view.drag) return;
    const { disk, from, target } = view.drag;
    view.drag = null;
    const accepted = emit('move', { disk, from, to: target });
    if (accepted) {
      view.travel.set(disk, { from, to: target, t0: view.clock });
    } else {
      view.shake = { peg: from, t0: view.clock };
    }
    settle();
  }

  canvas.addEventListener('pointerdown', down);
  // pointermove on the window, not the canvas: a drag that leaves the board must keep tracking and
  // must clamp at the outermost peg (see pegAt), which a canvas-local listener would drop the
  // moment the finger crossed the border.
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  // 触摸/鼠标回落：老 WebView 只发 touch 或只发 mouse。两条路径都用 `seenPointer` 挡住 ——
  // 现代浏览器 pointerdown 先到，同一手势不该被记两次。触摸一律 passive:false，
  // 否则滚动手势会把拖盘打断。
  let seenPointer = false;
  canvas.addEventListener('pointerdown', () => { seenPointer = true; });
  const shim = (ev, kind) => ({
    clientX: kind === 'end' ? ev.changedTouches[0].clientX : ev.touches[0].clientX,
    clientY: kind === 'end' ? ev.changedTouches[0].clientY : ev.touches[0].clientY,
    pointerId: 0,
    preventDefault: () => ev.preventDefault(),
  });
  const hasPoint = (ev, kind) => (kind === 'end' ? ev.changedTouches : ev.touches) && (kind === 'end' ? ev.changedTouches[0] : ev.touches[0]);
  canvas.addEventListener('touchstart', (ev) => {
    if (seenPointer || !hasPoint(ev, 'start')) return;
    down(shim(ev, 'start'));
  }, { passive: false });
  canvas.addEventListener('touchmove', (ev) => {
    if (seenPointer || !hasPoint(ev, 'start')) return;
    move(shim(ev, 'start'));
  }, { passive: false });
  canvas.addEventListener('touchend', (ev) => { if (!seenPointer) up(); }, { passive: false });
  canvas.addEventListener('mousedown', (ev) => {
    if (seenPointer || !window.addEventListener) return;
    if (typeof window.PointerEvent === 'function') return;   // 有 Pointer Events 就不走这条
    down({ clientX: ev.clientX, clientY: ev.clientY, pointerId: 1, preventDefault: () => ev.preventDefault() });
  });
  window.addEventListener('mousemove', (ev) => {
    if (seenPointer || typeof window.PointerEvent === 'function') return;
    move({ clientX: ev.clientX, clientY: ev.clientY, preventDefault: () => {} });
  });
  window.addEventListener('mouseup', () => { if (!seenPointer && typeof window.PointerEvent !== 'function') up(); });

  return Object.assign(view, {
    measure,
    skins,
    isMoving,
    wall,
    setGame(game) {
      view.game = game;
      view.travel.clear();
      view.drag = null;
      view.shake = null;
      settle();
    },
    settle,
    frame,
    // 订阅帧：回调拿到 (dt, clock)。演示用它走 clock 而不是 setInterval 的墙钟，于是暂停
    // 真的冻住演示，30/60/120Hz 下同一虚拟时长也走出同样的步数。
    onFrame(cb) {
      view.subs.push(cb);
      return () => { view.subs = view.subs.filter((f) => f !== cb); };
    },
    keepPumping(on) {
      view.keepAlive = !!on;
      if (view.keepAlive) settle();
    },
    // 时钟基准：暂停/恢复后第一帧不产生 dt（tick 里 last=0 的那一支）。
    pause(on) {
      const next = !!on;
      if (next === view.paused) return view.paused;
      view.paused = next;
      view.last = 0;
      settle();
      return view.paused;
    },
    setReducedMotion(on) {
      view.reducedMotion = !!on;
      if (view.reducedMotion) {
        // 正在飞的盘与抖动直接落到终态：减弱动效不是"把动画变慢"，是不动。
        view.travel.clear();
        view.shake = null;
        view.flashUntil = 0;
      }
      settle();
      return view.reducedMotion;
    },
    arm(disk, from, to) {
      view.travel.set(disk, { from, to, t0: view.clock });
      settle();
    },
    snap() {
      view.travel.clear();
      view.drag = null;
      view.shake = null;
      // 闪光也是时钟上的状态：不关掉刚赢的那一下，重开后的第一帧还在播上一局的彩带。
      view.flashUntil = 0;
      settle();
    },
    geom,
    pegPoint,
    diskPoint,
    pegAt,
    diskAt,
    flash(ms = FLASH_S * 1000) {
      if (view.reducedMotion) return settle();
      view.flashUntil = view.clock + ms / 1000;
      settle();
    },
    // The gate the runtime pref flip lands on: idempotent, and settles so a peg stops mid-swing
    // on the frame the setting changes rather than at the end of the 260ms decay.
    setReduceMotion(v) {
      const on = !!v;
      if (on === reduceMotion) return reduceMotion;
      reduceMotion = on;
      if (reduceMotion) settle();
      return reduceMotion;
    },
    isReducedMotion: () => reduceMotion,
    shakePeg(peg) {
      if (view.reducedMotion) return settle();
      view.shake = { peg, t0: view.clock };
      settle();
    },
    showHint(on) {
      view.hintOn = !!on;
      settle();
    },
    // A cheap fingerprint of the current frame, so a test can prove the canvas really changed.
    // It samples the whole surface: the top-left sixth of this board is empty sky, and a static
    // gradient would hash identically whether the tower moved or the picture froze.
    pixels() {
      const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i += 4 * 53) {
        h ^= d[i]; h = Math.imul(h, 16777619);
        h ^= d[i + 1]; h = Math.imul(h, 16777619);
        h ^= d[i + 2]; h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16);
    },
    PEG_NAMES,
  });
}
