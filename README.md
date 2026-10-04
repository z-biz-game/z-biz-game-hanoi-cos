# 汉诺塔 · HANOI

难度不是"这关盘多大"，是**印在关卡上的那个数字**。本仓 32 张 LOT 的 `par` 全部由**穷尽 BFS 走完
整张位置图**量出来，再与独立的算术路（三柱闭式 `2^n − 1`、四柱 Frame–Stewart 递推、线柱闭式
`3^n − 1`）逐位对账；对不上就构建失败。玩家超出 `par`，就是没达到一条已被证明的下界。

零依赖：无图片、无音频、无字体、无打包器、无 `npm install`。全部逻辑是浏览器原生 ES 模块 + Canvas 2D 程序绘制。

## 跑起来

```bash
node server.cjs 5192       # http://127.0.0.1:5192/
node tools/bake.mjs        # 重新测量并生成 js/data/lots.js（复现不出 par 就 exit 1）
for f in test/*.test.mjs; do node "$f"; done   # node 层：1642 条断言
bash tools/verify.sh       # node 1642 + 浏览器 185（真起 headless Chrome 真发鼠标事件）+ bake --check
```

路由：`#/lot/<id>`（分享某张 LOT，含 `#/lot/lot-line-<n>` 的 10 张线柱塔）、`#/daily`
（`hashSeed('daily|YYYY-MM-DD')` → 同一设备无关的同一局面）、`#/random/<band>/<token>`
（`band` 可为五个带之一，线柱见下）、`#/index`（LOT 目录）。测试钩子：`window.hanoi`。

## 三层

| 层 | 文件 | 允许做什么 |
| --- | --- | --- |
| 纯函数 | `js/core/{rng,game,solve,make,storage,library}.js` | 只有 `storage.js` 摸 `window.localStorage`，且守卫式 + 会抛异常 |
| 像素与手势 | `js/view.js` | 绘制 + 把一次拖拽变成一个 `moveTop(from, to)` 调用；不判合法性 |
| DOM 与状态 | `js/main.js` | 路由、面板、存档、`window.hanoi`；不写规则、不写算术 |

规则只有一份：`js/core/game.js:canMove`。BFS 生成邻接、生成器走步、玩家拖拽、测试复现，全部经过它。
变体规则也只有一份：`js/core/game.js:36` 的 `pegStepOk(from, to, rule)` 是 `canMove` 的第三个半句，
线柱的"只能移到相邻柱"因此与"大盘不能压小盘"走同一扇门，没有第二条实现。

## 数字从哪来（四条独立路 + 一个反证）

1. **穷尽 BFS**：`bfsTable(n, pegs, rule)` 遍历整张图（根在终局），给出 `dist[]`、`nextDisk/nextTo`、
   `routeCount[]`。最大的一张图 `3^13 = 1,594,323` 态，`node tools/bake.mjs` 本次实测这一档 99.3 ms
   （四柱最大档 `4^10 = 1,048,576` 为 109.5 ms；毫秒数是计时量，随负载漂移，态数与 par 是结构量）。
2. **闭式 / O(n) 递推**：`closedForm3(n) = 2^n − 1`；`dist3(state, n)` 对**任意**三柱位置给精确距离。
   `test/solve.test.mjs` 把 `dist3` 与 BFS 在 n ≤ 7 的**全部 3,279 个位置**逐位对账。
3. **Frame–Stewart**：`FS(n) = min_k 2·FS(n−k) + (2^k − 1)`，n=1..12 与公开值逐位相同（含 n=10 ⇒ 49）；
   `fsRoute(n)` 还能构造出那条路线，`replayRoute` 在真实规则下走一遍，走到终局才算数。
   四柱 n ≤ 10 的 FS 值在本仓**被穷尽 BFS 证实为最优**（不只是"上界"）。
4. **线柱闭式**（`test/line.test.mjs`，362 条）：三柱排成一行、只许挪到相邻柱时，角→角是 `3^n − 1`、
   角→中是 `(3^n − 1)/2`。该套件手抄了 n=1..13 的两列锚点，另起第三把尺子——手推递推
   `T(n) = 3·T(n−1) + 2`（`T(1)=2`）与 `S(n) = T(n−1) + 1 + S(n−1)`（`S(1)=1`）——并用 `T = 2·S`
   把两把尺子扣在一起（`test/line.test.mjs:49`）。三样都不从 `solve.js` 读回；两条闭式随后由
   穷尽 BFS 在 n = 1..13 上逐位复现（含 `complete`、`reached === 3^n`、`maxDist === 3^n−1`，
   即开局塔确实是终局的最远点），`routeCount` 在 n ≤ 8 实测为 1。
5. **反证**：把"大盘不能压小盘"这条规则关掉后重跑 BFS，n=3 的最优从 **7 变成 3**——
   规则真的在约束搜索，不是界面装饰。`tools/bake.mjs`、`test/solve.test.mjs`、`#/index` 三处都能看到这条。
   线柱方向同样有反证（`test/line.test.mjs:82`）：n=1..8 逐档比自由图与相邻图，
   断言 `line.dist > free.dist`（n=3 是 **26 > 7**）且 `line.edges < free.edges`，
   同时钉住 `free.dist` 与补丁之前一模一样——相邻限制真的在削图，而不是换了一套编码。

## 关卡表

`node tools/bake.mjs` 打印的 LOT 行（`n, pegs, par, routeCount, states, tier`）共 32 条：
三柱 n=1..13（par 1 → 8191，`routeCount` 全为 1，即三柱最短路线唯一，实测）；
四柱 n=2..10（par 3, 5, 9, 13, 17, 25, 33, 41, 49）；
**线柱三柱 n=1..10**（par 2, 8, 26, 80, 242, 728, 2186, 6560, 19682, 59048 = `3^n − 1`，
`routeCount` 同样全为 1）。带（tier）按塔形划：浅滩 / 连阶 / 缠盘 / 绝顶 / 线柱。

## 三个刻意的偏离与两处边界（照做之前先说清）

1. **乱盘（每日题、随机题）的 `par` 印的是该盘面被量出的最短距离，不是同塔形全塔的 `2^n − 1`。**
   规格 §3 要求"par 仍按闭式印"；但闭式属于全塔开局，对一个实测只需 15 步的乱盘印 8191，
   就是把一个**没人证明过的下界**当成"已证下界"卖给玩家。本仓的口径：闭式/FS 值仍作为
   `closedForm` / `frameStewart` 字段同行印出并标注为同塔形全塔值，`par` 一律是实测距离。
   规格这条约束的真正意图——**不按打乱步数 `k` 计费**——完全保留：`k` 只是生成过程的副产品，从不参与判定。
   详见 `DESIGN.md` §5。
2. **四柱 n=11、12（FS 65、81）不出 LOT 行。** 它们在 FS 已公布区间内，但 `4^11 = 41,943,040` 态
   超出本仓 `EXHAUST_LIMIT = 1,594,323`，bake 无法"从序列化产物重解并复现印着的 par"——
   按规格 §2 自己的规则（复现不出就剔除）整关不做。这两个数字仍作为期望值写死在
   `test/solve.test.mjs`（"知道但不出售"）。
3. **线柱不出乱盘，也不出 n > 10。** `js/core/make.js:131` 的 `canScramble` 对线柱直接返回 `false`：
   随机题的带宽（`bandFor`）是在**自由图**上实测出来的，搬到相邻柱的图上就是没人量过的难度承诺。
   上界同理：`dist3` 那条 O(n) 递推假设一个盘可以跳到**任意**柱，线柱图上不成立，所以线柱只能靠
   浏览器自己穷尽——`3^10 = 59,049 ≤ TABLE_BUDGET = 65,536`（`js/core/solve.js:44`），
   `3^11 = 177,147` 越过，于是 `js/core/make.js:45` 的 `LINE_MAX_N = 10` 是从预算量出来的，不是挑的。
   `#/random/line/<token>` 因此不生成新盘面，而是用 `hashSeed(token)` 从 10 张已烘焙的线柱行里挑一张
   （`js/core/library.js:117`）：它印的每个数都仍出自 `tools/bake.mjs`。
4. **每日题的日历不因新带而改变**：`dailyLevel` 用 `hash % TIERS.length` 选带，所以线柱是**追加**进
   `BANDS` 而不是插进 `TIERS`（`js/core/make.js:37-38`）——否则每个已经玩过的日期会静默换题。
   `test/library.test.mjs:191` 手抄了 4 个日期的所属带（`twined,linked,shoal,shoal`）断言与变体之前
   一致，并另扫一年（120 个日期）断言**零**个落到线柱带。

另有一处**超出规格**的交付：§6 说 n=13 的 `routeCount` 直接不印。本仓印了，因为构建期真的走完了
`3^13`（本次实测 99.3 ms），结果是 1——三柱最短路线唯一，这条是量出来的而不是引理。
线柱的 10 张行同样印 `1`（`test/line.test.mjs:66` 另有一档独立钉住 n ≤ 8 的最短路线唯一）。

## 界面口径

常驻面板：`已用步数` / `已证下界` / `剩余（最短）` / `超支`。完成时 `steps === par` → **认证解**；
`steps > par` → **已通关，但未达已证下界**。大盘压小盘的拖拽被拒绝且**不计数**（`@pointer` 必测）。
越界拖拽在最外柱钳制。四柱 n=9/10 的位置一旦离开认证路线，"剩余"显示 `—` 而不是猜一个数。
线柱局面上，相邻柱之间画一条轨道（`js/view.js:149` 的 `drawLinks`），抬起盘子时那一段按
`legalMoves(s, n, pegs, rule)` 的真实读数亮绿或亮红；被拒的拖拽会说清是哪半条规则说的"不"
（`js/main.js:147` 的 `refusalReason`：「线柱：只能移到相邻柱」/「大盘不能压小盘…」/「X 柱是空的」）。

## 端口

`tools/verify.sh` 默认 `WEB_PORT=5192 / CDP_PORT=9352`，必须与兄弟仓错开（gridlock :5180/:9340、
nine-rings 5181/9341、pour+lightsout 5190/9341、point24 5187/9347、ferry 5188/9348、
eulertrail 5186/9346、matchwork 5185/9345、tango 5191/9351）；同机同时只允许一个 headless Chrome。

## 测试

* node 层 7 个套件、**1642 条断言**（`test/{rng,solve,game,make,library,line,storage}.test.mjs`
  = 19/182/144/230/648/362/57），期望值全部手写死，不从实现读回。`test/line.test.mjs` 那一档专门
  把线柱的两条闭式、递推、穷尽复现、"限制确实削图"的反证与"本仓拒绝印什么"分开钉住。
* 浏览器层 `tools/verify.sh`：`@boot @play @routes @save @reloaded @pointer @line` 七段、**185 行**
  （36/27/49/16/8/28/21），`@pointer` 用 CDP `Input.dispatchMouseEvent` 真鼠标走完 `lot-3p-4` 的整条
  15 步认证解，`@line` 同样真鼠标走完 `lot-line-3` 的 26 步认证解、并抽样画布像素证明线柱局面上
  那条轨道真的被画出来、自由局面上没有。本机 2026-09-29 连跑两遍全绿且 console 干净
  （脏 console 计红：见 `DESIGN.md` §8 末两条；这次变体落地时的一次红写在 `DESIGN.md` §8.2）。
* `js/core/*` 的纯度由 `test/game.test.mjs` 源码扫描把守（`storage.js` 是唯一例外）。

MIT © z-biz-game

## 上线的到底是哪一批文件

这个仓没有打包器：站点=一次文件拷贝。以前「拷哪些」写在 `pages.yml` 的 `run:` 里（手抄的几行
`cp`）。本地 `index.html` 直读仓库根，永远自洽；线上却按那份清单拷，于是页面后来引用的
`manifest.webmanifest`、`sw.js`、`icons/*` 可能一个都没上去——线上 404，而仓里的引擎测试与
真浏览器闸全绿，因为它们跑的都是仓库根，没有任何一步在「按清单拷」的那个环境下加载过页面。

现在清单只有一份，住在 `tools/assemble-site.sh`：CI 调它拷 `_site`，本地闸调它拷临时目录，
然后**对拷出来的产物**提要求（`tools/deploy-set.mjs`）：

- **W 清单与页面同源**：`pages.yml` 里必须真有 `run: bash tools/assemble-site.sh <dir>` 这一行，
  `ci.yml` 里必须真有 `run: node tools/deploy-set.mjs`。认的是调用那一行，不是文件里出现过这个
  路径——注释里本来就会写它，只 grep 字符串会被一句散文喂绿。
- **R 引用可达**：引用不靠手打名单。从 `index.html` 的 `href/src` 出发，凡解析出来是 `.js`/`.css`
  的就把那一站也扫一遍（CSS 的 `url()`、JS 去掉注释后的 `'./…'` 字面量、`new URL(x, base)` 的两种
  基、`navigator.serviceWorker.register`、`scope`），`manifest` 的 icons/screenshots/shortcuts 各自
  的 `src` 也算引用。取径上读不到的那一站本身就是红（读不到＝这一站根本没扫）。每条引用都必须在
  产物里且非 0 字节；绝对路径单列一条红，因为 Pages 挂在 `/<repo>/` 前缀下会跳出去。
- **P 位图不许说谎**：`manifest` 声明的 `sizes` 必须等于 PNG IHDR 的真实宽高——文件图标读文件头，
  内联成 base64 的图标先解码再读同一段。后一条不是可选项：图标可能住在清单里而不是盘上的 `.png`
  （有的仓另有一条"零二进制文件"的承诺，那条只约束"有没有 .png 这个文件"）；如果 P 段只筛文件名，
  声明写 512 而真图 192 就一路放行。
- **钉住两个数**：R 段实际检查的路径条数（`29`）与这一次跑的断言条数（`47`），两个数
  都钉在 `tools/deploy-set.mjs` 顶部的那对常量里。没改页面却掉了，说明解析断了；删掉一张图标会同时
  少一条 R10 与那张的 P1/P2，所以两个数一起钉，断言条数能漂就是闸在缩水的信号。这一节故意只写数值、
  不写那对常量的名字，也不写别仓文档闸的编号：有的仓的文档闸会拿"文档里出现过的同名标识号"回数它
  自己的条数，还有的会把文档里点到的每个组编号逐个核对"这一轮真的发过"——两道闸共用一个名字，
  或者在本仓的文档里出现一个本仓没有的组编号，打红的都是不相干的那一边。

`tools/deploy-set-selftest.mjs` 是这两颗钉的阳性证明：它把仓库复制到临时目录，照着每一类断言
各下一刀（X1 清单不收位图目录 / X2 模块边改名 / X3 CSS 写绝对路径 / X4 `start_url` 绝对 /
X5 删光 >=512 图标 / X6 少一个必填字段 / X7 声明尺寸与真图不符 / X8 workflow 不调脚本 /
X9 CI 不跑闸 / X10 是阴性对照——往入口 JS 追加一行只写在注释里的假路径，闸必须仍然绿、条数仍然
`29`、断言仍然 `47`；X11 og:image 退回相对路径 / X12 og:image 的前缀指向别的 slug /
X13 内联位图谎报尺寸——只在有靶子时下：X11/X12 要页面上那句 og:image，X13 要清单里真有一段 base64
图标，没有就打印 SKIP；反过来 X1 没有位图目录可砍时改砍 css，P 段一位都不核时台架直接报靶子不够），
要求每一刀都让闸**点名**变红。靶子从 `DEPLOY_SET_DUMP=1`
的出处表现挑（取径真的会读的那支 JS / 那一张 CSS，不写死某一个仓的入口名），所以页面改了、仓与仓
不同，台架跟着走。

`node tools/deploy-set.mjs` 与 `node tools/deploy-set-selftest.mjs` 就是 CI 跑的那两条命令本身
（package.json 里的 `deploy-set` / `deploy-set:selftest` 只是同一支脚本的 npm 入口）；本仓的整闸在 `tools/verify.sh` 的 `=== deploy-set ===` 那一段也各跑一次。它们红的时候并进本仓那条出口的退出码——这一条是这么证的：
把 ci.yml 里那行 `run: node tools/deploy-set.mjs` 砍掉，本仓整闸必须点名红且退出码非 0。
所以「本地全绿、线上 404 自己的 manifest / sw.js / 图标」这一类坏法在本地就会红。

