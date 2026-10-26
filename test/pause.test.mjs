// test/pause.test.mjs — 暂停的**行为**，不是「暂停」这两个字。
//
// 这一支只钉三件事，每一件都是行为：
//   1. 暂停后表停住：面板上的「用时」一个数都不涨；
//   2. 暂停期间输入被挡：盘面落子与演示的推子都进不来；
//   3. 继续之后从暂停处接着走：不重复累加、不跳格，反复切换三次以上仍然对。
//
// 表是手摇的：`now` 注入 `createSession`，于是"又过去 8.4 秒"是一次赋值，不是真的等 8.4 秒
// ——闸要能在秒级内证伪，不能靠睡眠把一条断言拖成 8 秒。
//
// 最后一节是接线检查（读源码），不是行为断言：行为归 js/core/session.js，壳层有没有真的
// 问那道闸，只能从壳层的源码上读。它防的是"闸写好了没人用"——那种红会静悄悄地留着。

import { ok, eq, section, run } from '../tools/harness.mjs';
import { createSession } from '../js/core/session.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- 一支手摇的表 ----
let clock = 10_000;
const now = () => clock;
const session = createSession(now);

// 壳层的一扇门：落子前先问 allowInput()。这两段照抄 js/main.js 的 commit() 与演示节拍，
// 免得测试里另发明一套规矩——测试测的是闸，不是测试自己写的规矩。
const board = { steps: 0 };
function move() {
  if (!session.allowInput()) return false;
  board.steps++;
  return true;
}
function demoBeat() {
  if (!session.allowInput()) return false;
  board.steps++;
  return true;
}

section('pause: 暂停之后表停住了');
session.start();
clock = 11_600;                                   // 走了 1.6 秒
eq(session.elapsedMs(), 1600, '走了 1.6 秒，用时读数就是 1600 毫秒');
eq(session.allowInput(), true, '没暂停时盘面输入是放行的');
eq(session.paused, false, '此刻不在暂停态');
session.pause();
clock = 20_000;                                   // 暂停期间又过去 8.4 秒
eq(session.elapsedMs(), 1600, '暂停期间用时一个数都没涨');
eq(session.allowInput(), false, '暂停期间输入被挡');
eq(session.paused, true, '此刻在暂停态');

section('pause: 暂停期间一步也走不了');
eq(move(), false, '暂停期间的落子被挡');
eq(demoBeat(), false, '暂停期间演示的节拍推不动盘面');
eq(board.steps, 0, '一步也没走');
clock = 25_000;                                   // 暂停还没结束
eq(move(), false, '暂停没解除之前，落子一直被挡');
eq(board.steps, 0, '还是一步也没走');

section('pause: 继续之后从暂停处接着走');
session.resume();
eq(session.allowInput(), true, '继续之后输入恢复');
eq(session.paused, false, '已经不在暂停态');
clock = 25_500;                                   // 又走了 0.5 秒
eq(session.elapsedMs(), 2100, '继续后从暂停处接着走：1600 + 500，不重复累加也不跳格');
eq(move(), true, '继续之后落子又行了');
eq(demoBeat(), true, '演示的节拍也推得动了');
eq(board.steps, 2, '两步');

section('pause: 反复暂停/继续，用时仍然等于各段实跑之和');
{
  let expected = session.elapsedMs();
  for (let i = 0; i < 4; i++) {
    clock += 1000;                                // 这一段在跑
    expected += 1000;
    eq(session.elapsedMs(), expected, `第 ${i + 1} 轮：实跑的一段计入用时`);
    session.pause();
    clock += 5000;                                // 暂停的这 5 秒不算数
    eq(session.elapsedMs(), expected, `第 ${i + 1} 轮：暂停的 5 秒不计入用时`);
    session.resume();
  }
  clock += 1000;
  expected += 1000;
  eq(session.elapsedMs(), expected, '四轮暂停/继续之后，用时等于各段实跑之和');
  eq(session.paused, false, '四轮之后仍在继续态');
}

section('pause: 重复的暂停/继续不会把同一段时间算两遍');
{
  session.pause();
  const at = session.elapsedMs();
  session.pause();                                // 已经在暂停里了
  clock += 3000;
  eq(session.elapsedMs(), at, '第二次 pause() 不会重新起表');
  session.resume();
  session.resume();                               // 已经继续了
  clock += 300;
  eq(session.elapsedMs(), at + 300, '第二次 resume() 不会把暂停的那 3 秒也算进去');
  eq(session.elapsedMs(), at + 300, '继续之后只从此刻起算');
}

section('pause: 壳层真的问了那道闸（接线检查）');
{
  const here = fileURLToPath(new URL('..', import.meta.url));
  const main = readFileSync(join(here, 'js', 'main.js'), 'utf8');
  ok(/session\.allowInput\(\)/.test(main), 'js/main.js 里有一处以上 session.allowInput()：落子门与演示节拍都问这道闸');
  const view = readFileSync(join(here, 'js', 'view.js'), 'utf8');
  ok(/\bpaused\b/.test(view), 'js/view.js 里有暂停分支：画布的动画钟与手势都停');
}

const c = run();
process.exit(c.fails ? 1 : 0);
