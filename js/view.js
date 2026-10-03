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
// Drawing is procedural: pegs are tapered rectangles with a highlight, disks are rounded bars
// whose width is linear in diameter (game.js `diskWidth`), and the whole board is scaled by the
// device pixel ratio. No images, no fonts, no audio files.

import { DEFAULT_RULE, diskWidth, pegTops, decode, pegOf, legalMoves } from './core/game.js';

const PEG_NAMES = ['甲', '乙', '丙', '丁'];

export function createView(canvas, hooks = {}) {
  // willReadFrequently is not a micro-optimisation here: pixels() reads the whole surface back to
  // fingerprint a frame, and without this hint Chrome books it as a GPU→CPU copy per call and
  // prints a console warning — and a dirty console is a red gate (tools/verify.sh).
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  // ---- 减弱动效（prefers-reduced-motion）----
  // 本仓 css/game.css 里已经有一段 @media (prefers-reduced-motion: reduce)（.toast 的
  // transition），但那管不到 canvas：被拒的一步让柱子在
  // Math.sin((now - t0) / 22) * 3 的衰减里左右摆 3px，纯装饰，CSS 一点都拦不住。
  // 判据：拒绝本来就有 toast(refusalReason(...)) 那句人话读数（"大盘不能压小盘：…柱顶是
  // 第 N 号盘"），摆动是叠在读数上的装饰，归零位移不损失信息。
  // **柱子本身照旧照常画** —— 柱子是棋盘，不是反馈的一部分，动不得。
  let reduceMotion = false;
  const view = {
    game: null,
    painted: false,
    frames: 0,
    pending: 0,          // the rAF id settle() scheduled, or 0 when nothing is in flight
    dpr: 1,
    w: 0,
    h: 0,
    drag: null,          // { disk, from, x, y, target }
    travel: new Map(),   // disk -> { from, to, t0 }
    shake: null,         // { peg, t0 }
    hintOn: true,
    flashUntil: 0,
    lastRoute: -1,
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

  function diskPoint(disk) {
    const g = geom();
    const s = view.game ? view.game.state : 0;
    const peg = view.game ? pegOf(s, disk, g.pegs) : 0;
    const digits = view.game ? decode(s, g.n, g.pegs) : [];
    const slot = digits.slice(0, disk).filter((p) => p === peg).length;
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
    const slots = digits.slice(0, top).filter((p) => p === peg).length;
    const py = g.topOf(slots);
    if (y > py + g.diskH * 1.9) return -1; // pressed the shaft, not a liftable disk
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

  function draw() {
    const g = geom();
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    ctx.clearRect(0, 0, g.pad * 2 + g.usable, view.h + 4);

    const sky = ctx.createLinearGradient(0, 0, 0, view.h);
    sky.addColorStop(0, '#181b22');
    sky.addColorStop(1, '#0f1116');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, view.w, view.h);

    // base beam
    ctx.fillStyle = '#2a2f3a';
    roundRect(g.pad * 0.4, g.floor, g.usable + g.pad * 1.2, Math.max(10, view.h * 0.03), 6);
    ctx.fill();
    ctx.fillStyle = '#3b4250';
    roundRect(g.pad * 0.4, g.floor, g.usable + g.pad * 1.2, 4, 2);
    ctx.fill();

    // The 线柱 rail: a segment between every pair of neighbouring pegs and nothing else. A peg
    // pair with no segment in front of the finger is the restriction drawn, rather than a rule
    // the player has to remember.
    if (view.game && g.rule === 'line') drawLinks(g);

    for (let p = 0; p < g.pegs; p++) {
      const cx = g.center(p);
      const shake = view.shake && view.shake.peg === p && !reduceMotion ? Math.sin((now - view.shake.t0) / 22) * 3 * Math.max(0, 1 - (now - view.shake.t0) / 260) : 0;
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
        const t = Math.min(1, (now - trav.t0) / 190);
        if (t >= 1) view.travel.delete(d);
        peg = t < 0.5 ? trav.from : trav.to;
        lift = Math.sin(Math.PI * t) * g.diskH * 0.8;
      }
      const slots = digits.slice(0, d).filter((p) => p === peg).length;
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
      ctx.fillStyle = `rgba(255,236,190,${0.16 * ((view.flashUntil - now) / 420)})`;
      ctx.fillRect(0, 0, view.w, view.h);
    }

    view.painted = true;
    if (view.shake && now - view.shake.t0 > 300) view.shake = null;
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
      ctx.shadowColor = 'rgba(255,230,160,0.9)';
      ctx.shadowBlur = 12;
      ctx.strokeStyle = 'rgba(255,240,200,0.6)';
      roundRect(x - w / 2 - 2, y - h - 2, w + 4, h + 4, Math.min(8, h * 0.5));
      ctx.stroke();
      ctx.shadowBlur = 0;
    }
    if (w > 26 && h > 11) {
      ctx.fillStyle = 'rgba(15,16,20,0.72)';
      ctx.font = `${Math.max(9, h * 0.62)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText(String(d + 1), x, y - h * 0.3);
    }
    ctx.restore();
  }

  function isMoving() {
    return view.travel.size > 0 || view.drag || view.shake || performance.now() < view.flashUntil;
  }

  // The only pump this view has: one frame per call, plus one per animation frame while something
  // is still in motion. The picture used to freeze on the pre-move state — main.js poked
  // `view.settled = false` and nothing ever read that flag, so a move updated the maths and the
  // panel and left the canvas behind. Drawing is unconditional because the *game* can change
  // without anything being in motion (undo, restart, a programmatic move).
  function settle() {
    view.frames++;
    draw();
    if (view.pending || !isMoving()) return;
    view.pending = requestAnimationFrame(() => { view.pending = 0; settle(); });
  }

  // ---- gestures ---------------------------------------------------------------------------
  function localPoint(ev) {
    const rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, rect };
  }

  function down(ev) {
    if (!view.game || view.game.done) return;
    const { x, y } = localPoint(ev);
    const disk = diskAt(x, y);
    if (disk < 0) {
      const peg = pegAt(x);
      view.shake = { peg, t0: performance.now() };
      // The peg travels with the reason: a press on an empty column never reaches `moveTop`, so
      // this hook is the only place that can tell the shell which column stayed blank.
      emit('refuse', { reason: 'nothing to lift', peg });
      settle();
      return;
    }
    view.drag = { disk, from: pegOf(view.game.state, disk, view.game.pegs), x, y, target: pegOf(view.game.state, disk, view.game.pegs) };
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
      view.travel.set(disk, { from, to: target, t0: performance.now() });
    } else {
      view.shake = { peg: from, t0: performance.now() };
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

  return Object.assign(view, {
    measure,
    setGame(game) {
      view.game = game;
      view.travel.clear();
      view.drag = null;
      view.shake = null;
      settle();
    },
    settle,
    // Snap the picture to the model. `travel` and `shake` animate *a move*, so undo and restart
    // change the truth underneath them: without this the last eased frame keeps playing over a
    // board that no longer matches it, and a frame fingerprint taken just after a restart reads
    // that leftover tail as "the picture is unstable while nothing happens".
    snap() {
      view.travel.clear();
      view.drag = null;
      view.shake = null;
      settle();
    },
    geom,
    pegPoint,
    diskPoint,
    pegAt,
    diskAt,
    flash(ms = 420) {
      view.flashUntil = performance.now() + ms;
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
      view.shake = { peg, t0: performance.now() };
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
