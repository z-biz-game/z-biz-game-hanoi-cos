// 音效：全部现算，不采任何音频文件（这个仓的资产只有位图）。
//
// 静音是真静音，不是把 gain 设 0：
//   1) `setMuted(true)` 立刻 `suspend()` 住 AudioContext —— 已经排队的包络不再走表；
//   2) 静音态下 `play()` 第一行就返回，**一个节点都不新建**（新建了再设 0 增益，等于一边
//      假装安静一边继续烧 CPU 和句柄）；
//   3) 取消静音 `resume()`，之后的事件照常出声。
// 这两条都被 `stats.created` 计数钉住：台架与浏览器 harness 各测一次「静音 N 次动作后
// created 增量为 0」，假静音会当场露出来。
//
// AudioContext 只在第一次真实手势里创建（`unlock()`）：在无手势时创建，Chrome 会往控制台
// 打一条 "The AudioContext was not allowed to start" 的 warning，而本仓的验收线把控制台
// 干净算作红。

const VOICES = {
  // kind: [wave, 起频, 止频, 时长秒, 峰值增益]
  lift: ['triangle', 340, 470, 0.07, 0.10],
  drop: ['triangle', 230, 132, 0.11, 0.20],
  refuse: ['sawtooth', 96, 74, 0.16, 0.13],
  ui: ['square', 660, 640, 0.035, 0.05],
  win: ['triangle', 0, 0, 0.16, 0.16],       // 走下面的琶音分支
  fanfare: ['triangle', 0, 0, 0.2, 0.14],
};

// 认证解的琶音：黄铜五度上行，音高对上了「步数与下界一致」这件事，不响成一段庆祝音乐。
const WIN_NOTES = [392, 494, 587, 784];

export function createSfx() {
  const stats = { created: 0, played: 0, mutedPlays: 0, suspended: 0, resumed: 0, blocked: 0 };
  let ctx = null;
  let master = null;
  let muted = false;

  // Chrome 的 autoplay 策略会在"没有用户激活就新建 AudioContext"时往控制台写一条
  // "The AudioContext was not allowed to start" 的 warning，而本仓的红门槛是控制台必须干净。
  // 问得到激活状态就先问（调用点全在手势里，答案几乎总是 true）；问不到（老 Safari 没有
  // navigator.userActivation）退回照建，不因此静默丢掉音效。
  function activated() {
    const ua = typeof navigator !== 'undefined' && navigator.userActivation;
    return ua && typeof ua.hasBeenActive === 'boolean' ? ua.hasBeenActive : true;
  }

  function ensure() {
    if (ctx) return ctx;
    const Ctor = typeof AudioContext === 'function' ? AudioContext
      : (typeof webkitAudioContext === 'function' ? webkitAudioContext : null);
    if (!Ctor) return null;
    if (!activated()) { stats.blocked++; return null; }
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.9;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
      master = null;
      return null;
    }
    return ctx;
  }

  function tone(c, t, wave, from, to, dur, peak) {
    const osc = c.createOscillator();
    const g = c.createGain();
    stats.created++;
    osc.type = wave;
    osc.frequency.setValueAtTime(from, t);
    if (to && to !== from) osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.02, dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    return osc;
  }

  function play(kind, at = 0) {
    if (muted) { stats.mutedPlays++; return false; }
    const c = ensure();
    if (!c) return false;
    const v = VOICES[kind];
    if (!v) return false;
    const t = c.currentTime + at;
    if (kind === 'win' || kind === 'fanfare') {
      WIN_NOTES.forEach((f, i) => tone(c, t + i * 0.1, 'triangle', f, f * 1.01, v[3], v[4]));
    } else {
      tone(c, t, v[0], v[1], v[2], v[3], v[4]);
    }
    stats.played++;
    return true;
  }

  const settle = (p) => (p && typeof p.catch === 'function' ? p.catch(() => {}) : Promise.resolve());

  return {
    stats,
    get muted() { return muted; },
    get state() { return ctx ? (ctx.state || 'unknown') : 'idle'; },
    // 只在真实手势里调用：pointerdown / keydown 的第一站。
    unlock() { return !!ensure(); },
    play,
    setMuted(on) {
      const next = !!on;
      if (next === muted) return muted;
      muted = next;
      if (!ctx) return muted;
      if (muted) {
        // 老版 Safari 没有 suspend()：没有就只走「不新建节点」那条，不因此抛异常。
        if (typeof ctx.suspend === 'function') { settle(ctx.suspend()); stats.suspended++; }
      } else if (typeof ctx.resume === 'function') {
        settle(ctx.resume());
        stats.resumed++;
      }
      return muted;
    },
  };
}

export default createSfx;
