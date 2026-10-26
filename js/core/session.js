// The clock and the pause gate of one play session — and nothing else.
//
// Two things live here, and they exist for one reason: a player who is interrupted (a phone
// call, a doorbell, a second tab) has to come back to the board they left, not to a board
// whose clock ran on without them. The clock is the only time source the shell shows (the
// panel's 「用时」); the gate is the one door every input has to pass — a finger on the canvas,
// the auto-demo's beat, the keyboard shortcuts.
//
// Pure state: no DOM, no window, no timer of its own. The clock function is injected, so a
// test can crank it by hand instead of waiting on the wall clock, and the shell hands in
// `performance.now()` (monotonic) rather than the wall clock (which can jump).
//
// The pause is not "the board stops": it is "the table stops and the board is frozen". The
// table is the player's own time — thinking is not moving — so pausing is what turns an
// interrupted session into a fair one. Everything that used to advance while nobody was
// looking (the demo's beat, the canvas animation clock) asks the same question before it
// advances: `allowInput()`.

/**
 * One session: a stopwatch and a gate.
 *
 * @param {() => number} now monotonic milliseconds; injected so the tests can drive it by hand.
 */
export function createSession(now = () => Date.now()) {
  let base = 0;        // 已跑完的毫秒：每一段"没被暂停打断"的用时都记在这儿
  let mark = 0;        // 本段的起点
  let running = false; // 表是否在走
  let paused = false;  // 是否处于暂停态

  // 表读数：走的时候是 base + 本段已走，停下时就是 base —— 暂停期间它一个数都不涨。
  const elapsed = () => base + (running ? now() - mark : 0);

  function start() {
    if (running || paused) return;
    mark = now();
    running = true;
  }

  function stop() {
    if (!running) return;
    base += now() - mark;
    running = false;
  }

  function pause() {
    if (paused) return false;
    stop();          // 先停表：暂停的第一件事就是让用时不再增长
    paused = true;
    return true;
  }

  function resume() {
    if (!paused) return false;
    paused = false;
    start();         // 从暂停处接着走：base 原样留着，mark 从此刻起算
    return true;
  }

  function toggle() {
    if (paused) {
      resume();
      return false;
    }
    pause();
    return true;
  }

  function reset() {
    base = 0;
    mark = 0;
    running = false;
    paused = false;
  }

  return {
    get paused() { return paused; },
    get running() { return running; },
    start,
    stop,
    pause,
    resume,
    toggle,
    reset,
    elapsedMs: elapsed,
    // 盘面输入闸：壳层的每一次落子与演示的每一次推子都先问这一句。暂停期间它是 false，
    // 于是「暂停」不是一句提示，而是真的接不住输入。
    allowInput() { return !paused; },
  };
}
