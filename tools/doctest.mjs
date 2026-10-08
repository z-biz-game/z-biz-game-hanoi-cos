// tools/doctest.mjs — 文档引用腿（零依赖）：README / DESIGN 里印着的每一个 `path:NN` 都被读回来对账。
//
// 为什么要有这一支：这个仓的文档里有几十条「去看第 N 行」，而 `tools/` 里以前一条闸都没核过它们。
// 「文档说的是第 149 行」这句话的真假，全靠写文档那一刻有人手算过：改了代码不重编行号，文档不会响，
// 读者按图索骥找到的是别的东西。这一腿把那句话变成一条会红的断言。
//
// 两半各防一种谎：
//   · 范围半（citeMiss）：文件在盘上、行号落在真实行数内、**被指的那几行不许整段是空白**——「在界内」
//     不等于「指到了代码」，一条裸引用完全可能只指到一段行距；
//   · 锚点半（anchorMiss）：贴着引用写在反引号里的那个标识符，必须作为**完整标识符**出现在被指的那几行里。
//     整词而不是子串：子串口径比它替掉的手抄锚点表更弱——一个短名字会"出现在"任何碰巧含它的标识符里，
//     于是把一次真的漂读成绿（`pegStepO` 坐在声明 `pegStepOk` 的那一行上，子串算命中，整词不算）。
//
// 口径（fleet 同源，不是这一仓自创）：
//   · 只有反引号里的 `path:NN` / `path:NN-MM` 算引用；
//   · 五种指认写法产出锚点：`name`（`path:NN`）、`path:NN`（`name`）、`path:NN` 的 `name`、
//     `path:NN`（`fn(a, b)`）、`path:NN`（`dir/file.js::symbol`）；
//   · `::` 的切分发生在 `/` 的拒绝**之前**，否则带目录限定的符号会丢掉它的锚点；
//   · body 里写着 `<占位>` 时锚点是它的字面量前缀，且只在真写了占位时才这样切（否则 `test:docs` 会被砍成 `test`）；
//   · body 带空格是命令行（`npm test`），不是名字：拿它第一个词去锚是一次凭空的假红；
//   · 纯标点间隔（`，`、`、`）不构成指认：它前面那个名字只是上一条列表项；
//   · 裸 `:NN`（不带文件名）向同一句里最近的**完整引用**借文件，但借不到就计入「无法定址」：句号收住、
//     空行、新标题都断掉继承——散文折行可以续，跨句不许续；
//   · 整段空白的引用是 MISS 而不是命中；锚点查整词不查子串。
//
// 这一腿不覆盖什么：它只证明印在纸上的行号还坐在它所描述的那几行上，不证明周围的句子。
// 跑法只有一条命令：`node tools/doctest.mjs` —— 它同时住在 package.json 的 `doctest`、`npm test` 的链里、
// tools/verify.sh 与 .github/workflows/ci.yml。只在本地或只在 CI 跑的门不算门。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ok, eq, section, run, counters } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tools/doctest.mjs';
const CMD = 'node tools/doctest.mjs';
const SKIP_DIRS = new Set(['.git', 'node_modules', '_scratch', '_site', '_tmp', 'shots']);
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const PATH_SRC = '[\\w./@-]+?\\.[A-Za-z][A-Za-z0-9]{0,11}'; // 后缀不许写死：写死成某一族的语言时，本腿在那种仓里是哑的，而「0 条引用」读起来和「全核过」一模一样
const CITE = new RegExp('^(' + PATH_SRC + '):([0-9]+(?:[,-][0-9]+)*)$');
const BARE = /^:([0-9]+(?:[,-][0-9]+)*)$/;
// 锚点可以是成员路径（`view.cellCenter`）但绝不能是文件路径：body 里带 `/` 的是另一条引用，
// 拿它当字符串去被指的那几行里找，只会凭空造出一条假红。
const ID = /^[A-Za-z_$][A-Za-z0-9_$]{2,}(?:\.[A-Za-z_$][A-Za-z0-9_$]+)*$/;
const STOP = /[。！？；]/;

// 三条地板 + 台账把数 + 本闸项数：文档被删空、解析器扑空、有人删掉一条断言，都撞在这里。
// 地板钉的是本轮实测（51 条引用 / 16 条带指认），不是凑出来的整数：文档一旦少了引用就是这里红，
// 而"解析器一条都没推到"永远不可能被读成绿。
const CITE_FLOOR = 51;
const ANCHOR_FLOOR = 16;
const KNIVES = 9;
const EXPECT_ROWS = 17;
const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

const tokOf = (body) => {
  const seg = body.includes('::') ? body.slice(body.lastIndexOf('::') + 2) : body;
  if (seg.includes('/')) return '';
  const tpl = /^([^<>]+?)<[^<>\s]+>/.exec(seg);
  if (tpl && ID.test(tpl[1].split(':')[0].trim())) return tpl[1].split(':')[0].trim();
  const head = seg.split('(')[0].trim();
  if (ID.test(head)) return head;
  const lhs = head.split(/[=:]\s/)[0].trim();
  return ID.test(lhs) ? lhs : '';
};

let tree = null;
const theTree = () => {
  if (tree) return tree;
  const out = [];
  (function dig(dir) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (SKIP_DIRS.has(name)) continue;
      const rel = dir ? `${dir}/${name}` : name;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) dig(rel);
      else out.push(rel);
    }
  })('');
  tree = out;
  return tree;
};

// 写下来的路径怎么落地：整路径优先；只写文件名时，必须全树唯一才敢认。
const resolvePath = (p) => {
  const clean = p.replace(/^\.\//, '');
  if (fs.existsSync(path.join(ROOT, clean))) return clean;
  const hits = theTree().filter((f) => f === clean || f.endsWith('/' + clean));
  return hits.length === 1 ? hits[0] : null;
};

const lineCache = new Map();
const linesOf = (p) => {
  const rel = resolvePath(p);
  if (!rel) return null;
  if (!lineCache.has(rel)) {
    const arr = read(rel).split('\n');
    if (arr[arr.length - 1] === '') arr.pop();
    lineCache.set(rel, arr);
  }
  return lineCache.get(rel);
};

// 裸 `:NN` 的出处：同一句里最近的**完整引用**。散文里点到过的文件名不算出处（那会把引用认给
// 一个句子顺口提到的文件，绿在错的文件上比红更糟）。同一行内不限距离；跨行只在句子还没收住时续，
// 空行与标题断掉。
const inheritedPath = (text, spans, i) => {
  for (let j = i - 1; j >= 0; j--) {
    const pc = spans[j].body.match(CITE);
    if (!pc) continue;
    const between = text.slice(spans[j].end, spans[i].s);
    if (between.includes('\n') && (STOP.test(between) || /\n[ \t]*\n/.test(between) || /\n#{1,6} /.test(between))) return null;
    return { path: pc[1] };
  }
  return null;
};

const parseRefs = (text, orphans = null) => {
  const spans = [];
  const spanRe = /`([^`\n]+)`/g;
  let m;
  while ((m = spanRe.exec(text))) spans.push({ body: m[1], s: m.index, end: m.index + m[0].length });
  const out = [];
  for (let i = 0; i < spans.length; i++) {
    const full = spans[i].body.match(CITE);
    const bare = full ? null : BARE.exec(spans[i].body);
    let filePath = null;
    let range = null;
    if (full) { filePath = full[1]; range = full[2]; }
    else if (bare) {
      const owner = inheritedPath(text, spans, i);
      if (!owner) { if (orphans) orphans.push(bare[0]); continue; }
      filePath = owner.path;
      range = bare[1];
    } else continue;
    let anchor = '';
    let consumed = false;
    const next = spans[i + 1];
    const gA = next ? text.slice(spans[i].end, next.s) : null;
    if (gA !== null && gA.length <= 4 && !gA.includes('\n')) {
      const gN = gA.replace(/\s+/g, '');
      if (/^[（(]/.test(gN) || gN === '的') { consumed = true; anchor = tokOf(next.body); }
    }
    // 后向只在"前向不是指认形状"时兜底——挂在 `else if` 上会让短前向间隔但推不出锚点的那种写法整个丢掉后向半边。
    if (!consumed && i > 0) {
      const prev = spans[i - 1];
      const gap = text.slice(prev.end, spans[i].s);
      const gT = gap.replace(/\s+/g, '');
      const shaped = /^[（(]/.test(gT) || /[\w一-鿿]/.test(gT);
      if (shaped && !/\s/.test(prev.body) && gap.length <= 4 && !gap.includes('\n')) anchor = tokOf(prev.body);
    }
    for (const seg of range.split(',')) {
      const parts = seg.split('-').map(Number);
      out.push({ path: filePath, from: parts[0], to: parts[parts.length - 1] || parts[0], anchor, cont: !!bare });
    }
  }
  return out;
};

// 整词而不是子串（口径见文件头）。缓存是因为一条腿要对同一个名字核上百次。
const wordCache = new Map();
const hasWord = (text, name) => {
  if (!wordCache.has(name)) {
    wordCache.set(name, new RegExp('(^|[^A-Za-z0-9_$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^A-Za-z0-9_$])'));
  }
  return wordCache.get(name).test(text);
};

// 范围半：不存在 / 越界 / 整段空行，三道都在这一条代码路径上。空行那一道单独抽出来是为了让
// 下面那把指向空行的刀走**同一条路径**——把空行那道删掉，范围检查照样全绿，只有这一把会立刻红。
const citeMiss = (file, fromRaw, toRaw) => {
  const from = Number(fromRaw);
  const to = Number(toRaw === undefined || toRaw === null ? fromRaw : toRaw);
  const label = `${file}:${from}${to !== from ? '-' + to : ''}`;
  const lines = linesOf(file);
  if (!lines) return `${label} 文件不存在或同名不唯一`;
  if (from < 1 || from > to || to > lines.length) return `${label} 越界（${file} 共 ${lines.length} 行）`;
  if (lines.slice(from - 1, to).join('').trim() === '') return `${label} 那几行整段是空行`;
  return '';
};

// 锚点半：也在一条抽出来的路径上，好让"截前缀"那把刀走同一条路径。
const anchorMiss = (r) => {
  const lines = linesOf(r.path);
  if (!lines) return `${r.path}:${r.from} 文件不存在或同名不唯一`;
  if (r.from < 1 || r.from > r.to || r.to > lines.length) return `${r.path}:${r.from} 越界`;
  const body = lines.slice(r.from - 1, r.to).join('\n');
  return hasWord(body, r.anchor) ? '' : `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''} 那几行里没有 ${r.anchor}`;
};

const audit = (text) => {
  const orphans = [];
  const refs = parseRefs(text, orphans);
  const off = [];
  const anchorBad = [];
  for (const r of refs) {
    const miss = citeMiss(r.path, r.from, r.to);
    if (miss) { off.push(miss); continue; }
    if (r.anchor) {
      const bad = anchorMiss(r);
      if (bad) anchorBad.push(bad);
    }
  }
  // `` `file`（N 行）`` 是现量：这一格用等号收，不用地板。
  const cntRe = new RegExp('`(' + PATH_SRC + ')`（([0-9]+) 行）', 'g');
  let k;
  while ((k = cntRe.exec(text))) {
    const lines = linesOf(k[1]);
    if (!lines) off.push(`${k[1]}（${k[2]} 行）文件不存在或同名不唯一`);
    else if (lines.length !== Number(k[2])) off.push(`${k[1]} 实测 ${lines.length} 行，文档写的是 ${k[2]}`);
  }
  return { refs, off, anchorBad, unaddressed: orphans.length };
};

// 输入集由目录现数，不是手抄名单：手抄的名单会悄悄缩水而闸继续打印"全在范围内"。
const scan = () => {
  const docs = fs.readdirSync(ROOT).filter((f) => f.endsWith('.md') && fs.statSync(path.join(ROOT, f)).isFile());
  let docText = '';
  const off = [];
  const anchorBad = [];
  let refs = 0;
  let unaddressed = 0;
  for (const f of docs) {
    const t = read(f);
    docText += t + '\n';
    const a = audit(t);
    refs += a.refs.length;
    unaddressed += a.unaddressed;
    for (const b of a.off) off.push(`${f} · ${b}`);
    for (const b of a.anchorBad) anchorBad.push(`${f} · ${b}`);
  }
  const anchored = parseRefs(docText).filter((r) => r.anchor).length;
  return { docs, docText, refs, anchored, unaddressed, off, anchorBad };
};

const say = (s) => console.log(`        ${s}`);

section('文档引用对账 · 范围 + 空行 + 整词锚点');
const s = scan();
ok(s.docs.length >= 2, `文档引用腿：本仓根下至少两份文档可审（输入集不许自己空掉）`);
say(`${s.docs.length} 份：${s.docs.join(' ')}`);
ok(s.refs >= CITE_FLOOR, `文档引用腿：解析到的 文件:行号 引用多到它自己算覆盖面（地板 ${CITE_FLOOR} 条；引用格式被改了或解析断了就是这里红）`);
say(`本次解析 ${s.refs} 条 · 其中裸续引借到出处 ${parseRefs(s.docText).filter((r) => r.cont).length} 条`);
eq(s.off.length, 0, `文档引用腿：每一条引用都在盘上、落在真实行数内、且被指的那几行整段不许是空行`);
if (s.off.length) s.off.slice(0, 12).forEach(say);
eq(s.anchorBad.length, 0, `文档引用腿：贴着引用写在反引号里的那个名字，作为完整标识符坐在被指的那几行里（整词口径，不认子串）`);
if (s.anchorBad.length) s.anchorBad.slice(0, 12).forEach(say);
ok(s.anchored >= ANCHOR_FLOOR, `文档引用腿：带指认的引用不少于 ${ANCHOR_FLOOR} 条（少了就是锚点半边在空转，那不是"更绿"）`);
say(`认到锚点 ${s.anchored} 条 · 无法定址 ${s.unaddressed} 处 · 头八条：${parseRefs(s.docText).filter((r) => r.anchor).slice(0, 8).map((r) => `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''}=${r.anchor}`).join(' ')}`);

// ---- 台账：假引用一把不落。三道真查（范围、空行、整词）各自都有一把刀钉在里面 ----
const probe = linesOf(SELF) || [];
let blankAt = 0;
for (let i = 1; i < probe.length; i++) if (String(probe[i]).trim() === '') { blankAt = i + 1; break; }
// 截前缀的刀从**真文档**的现推锚点里挑：削掉最后一格之后仍是被指那几行的子串、却不再是完整标识符。
// 挑不出候选就当场红——口径退回子串的那一天，正是所有候选都"过"、这把刀空掉的那一天。
const wordKnife = (() => {
  for (const d of parseRefs(s.docText).filter((r) => r.anchor)) {
    const lines = linesOf(d.path) || [];
    const body = lines.slice(d.from - 1, d.to).join('\n');
    const cut = d.anchor.slice(0, -1);
    if (cut.length < 3 || !body.includes(d.anchor) || !body.includes(cut)) continue;
    if (anchorMiss({ ...d, anchor: cut })) return { d, cut };
  }
  return null;
})();
const fallBack = '`js/core/game.js:36`（`pegStepO`）';
const nine = '出处 `js/core/nope.js:1`、`js/core/solve.js:99999`、`NO_SUCH_NAME` 在 `js/core/game.js:1`、' +
  '`package.json`（999 行）、`js/core/game.js:1`（`pegStepOk`）、`js/core/game.js:1` 的 `pegStepOk`、' +
  '`js/core/game.js:1`（`Math.max(2, 3)`）' + (blankAt ? '、`' + SELF + ':' + blankAt + '`' : '') +
  '、' + (wordKnife ? `\`${wordKnife.d.path}:${wordKnife.d.from}${wordKnife.d.to !== wordKnife.d.from ? '-' + wordKnife.d.to : ''}\`（\`${wordKnife.cut}\`）` : fallBack);
const ledger = audit(nine);
const fakes = [...ledger.off, ...ledger.anchorBad];
ok(blankAt > 0 && fakes.length === KNIVES && !!wordKnife,
  `文档引用腿：${CN[KNIVES]}把假引用一把不落（不存在 / 越界 / 行数写错 / 后向指认漂 / 前向括号漂 / 「的」漂 / 调用形式漂 / 无锚点落在现量的空行 / 前缀不算整词），且真文档里挑得出一把截前缀的对照刀`);
say(`空行靶子现量在第 ${blankAt} 行 · 前缀刀：${wordKnife ? `${wordKnife.d.path}:${wordKnife.d.from} 的 ${wordKnife.d.anchor} 截成 ${wordKnife.cut}` : '挑不出候选'} · 抓到 ${fakes.length} 把`);
if (fakes.length !== KNIVES) fakes.forEach(say);

// ---- 阳性对照：同一解析器必须把这些判绿，否则上面的红可能只是解析器自己的 bug ----
const pkg = linesOf('package.json');
const pos = audit('`pegStepOk`（`js/core/game.js:36`）、`js/core/game.js:36`（`pegStepOk`）、`js/core/game.js:36` 的 `pegStepOk`、' +
  '`js/core/make.js:45` 的 `LINE_MAX_N = 10`、`js/core/game.js:36`（`pegStepOk(from, to, rule)`）、' +
  '`js/core/game.js:36`（`js/core/game.js::pegStepOk`）、`js/core/game.js:36`（`npm test`） 与 `package.json`（' +
  (pkg ? pkg.length : 0) + ' 行）');
eq([...pos.off, ...pos.anchorBad].length, 0, `文档引用腿：五种真指认形状 + 带空格的命令行 body + 真行数在同一口径下全判绿`);
eq(pos.refs.length, 7, `文档引用腿：正样本真的解析到 7 条引用（第 8 处是「N 行」等值，不是引用）`);

const tplG = audit('`js/core/game.js:36`（`pegStepOk:<占位>`）');
const tplR = audit('`js/core/game.js:36`（`NOPE:<占位>`）');
ok(tplG.anchorBad.length === 0 && tplG.refs.length === 1 && tplR.anchorBad.length === 1,
  `文档引用腿：body 写着占位时锚点是字面量前缀（前缀对得上判绿、对不上必须红）`);
say(`红在 ${tplR.anchorBad.join(' | ') || '（一处都没红）'}`);

const comma = audit('`NO_SUCH_NAME`，`js/core/game.js:36`');
ok(comma.anchorBad.length === 0 && comma.refs.length === 1,
  `文档引用腿：纯标点间隔（「，」）不构成指认，这种写法必须判绿`);
say(`${comma.anchorBad.join(' | ') || '绿'}（refs=${comma.refs.length}）`);

// ---- 续引：借得到出处的要真被核，借不到的一律计入「无法定址」，且不许悄悄借给别的文件 ----
const contG = audit('线柱五道闸（`tools/bake.mjs:141-166`）：`:144`、`:152`');
ok(contG.refs.length === 3 && contG.refs.every((r) => r.path === 'tools/bake.mjs') && contG.off.length === 0 && contG.unaddressed === 0,
  `文档引用腿：同一句里的裸 \`:NN\` 借到前一条完整引用的文件，并真的参与范围检查`);
say(`refs=${contG.refs.map((r) => `${r.path}:${r.from}-${r.to}`).join(' ')}`);
const contStop = audit('上面 `js/core/game.js:36`。\n下面 `pegStepOk`（`:36`）');
const contHead = audit('出处 `js/core/game.js:36`\n\n## 新一节\n`:45`');
ok(contStop.refs.length === 1 && contStop.unaddressed === 1 && contHead.refs.length === 1 && contHead.unaddressed === 1,
  `文档引用腿：句号收住、空行与新标题都断掉继承——断掉的那条落进「无法定址」而不是借给上一节的文件`);
say(`句号后 refs=${contStop.refs.length} 无法定址=${contStop.unaddressed} · 标题后 refs=${contHead.refs.length} 无法定址=${contHead.unaddressed}`);

// ---- 刀（只在内存里下，盘上一个字节不动）：把文档里一条界内的真引用挪歪一格，这一腿必须认它漂 ----
let needle = null;
for (const r of parseRefs(s.docText).filter((x) => x.anchor)) {
  const lines = linesOf(r.path) || [];
  const to = r.to + 1;
  if (to > lines.length) continue;
  const label = `${r.path}:${r.from}${r.to !== r.from ? '-' + r.to : ''}`;
  const poisoned = audit(s.docText.split('`' + label + '`').join('`' + `${r.path}:${r.from + 1}-${to}` + '`'));
  if (poisoned.anchorBad.length >= 1) { needle = { label, anchor: r.anchor, bad: poisoned.anchorBad[0] }; break; }
}
ok(!!needle, `文档引用腿：把文档里一条界内的真引用挪歪一格（文件还是那个文件），锚点半边必须为它变红`);
say(needle ? `${needle.label} → 挪一格后红在 ${needle.bad}` : `带指认的 ${s.anchored} 条里没有一条挪歪会红——锚点是摆设`);

// ---- 接线：同一条命令住在 package.json / npm test 链 / verify.sh / ci.yml 四处 ----
const PKG = JSON.parse(read('package.json'));
const VERIFY = read('tools/verify.sh');
const CI = read('.github/workflows/ci.yml');
const ASSEMBLE = read('tools/assemble-site.sh');
const HTML = read('index.html');
ok(PKG.scripts.doctest === CMD && PKG.scripts.test.includes('npm run doctest') && VERIFY.includes(CMD) && CI.includes('npm run doctest'),
  `文档引用腿：\`${CMD}\` 就是 package.json 的 doctest，同时住在 npm test 链里、tools/verify.sh 与 .github/workflows/ci.yml（本地与 CI 调同一条命令，只在一处跑的不算门）`);
say(`pkg.doctest=${PKG.scripts.doctest} · npm test 链=${PKG.scripts.test.includes('npm run doctest')} · verify.sh=${VERIFY.includes(CMD)} · ci=${CI.includes('npm run doctest')}`);
ok(!CI.includes('*.test.mjs') && !/\bcp\b[^\n]*\/tools\/|[^\n]*\bcp\b[^\n]* tools\//.test(ASSEMBLE) && !/doctest/.test(HTML),
  `文档引用腿：ci.yml 调脚本而不是抄一份 glob；站点清单不拷 tools/，页面也不引用本闸——闸不许被卷进产物`);
say(`ci 内联 glob=${CI.includes('*.test.mjs')} · 清单拷 tools=${/cp[^\n]* tools\//.test(ASSEMBLE)} · index.html 提到 doctest=${/doctest/.test(HTML)}`);

// ---- 文档读数钉成等式：这一腿印出去的数字必须等于这一跑数到的（改文档不跑闸就红） ----
const claims = [...s.docText.matchAll(/解析 (\d+) 条/g)].map((x) => Number(x[1]));
const anchorClaims = [...s.docText.matchAll(/认到锚点 (\d+) 条/g)].map((x) => Number(x[1]));
const gapClaims = [...s.docText.matchAll(/无法定址 (\d+) 处/g)].map((x) => Number(x[1]));
const knifeClaims = [...s.docText.matchAll(/台账 (\d+) 把/g)].map((x) => Number(x[1]));
ok(claims.length >= 1 && claims.every((c) => c === s.refs) && anchorClaims.length >= 1 && anchorClaims.every((c) => c === s.anchored) &&
  gapClaims.length >= 1 && gapClaims.every((c) => c === s.unaddressed) && knifeClaims.length >= 1 && knifeClaims.every((c) => c === KNIVES),
  `文档引用腿：文档里印的「解析 N 条」「认到锚点 N 条」「无法定址 N 处」「台账 N 把」都等于这一跑数到的（一处都没写也算红）`);
say(`闸数到 ${s.refs}/${s.anchored}/${s.unaddressed}/${KNIVES} · 文档写了 ${claims.join('/')} · ${anchorClaims.join('/')} · ${gapClaims.join('/')} · ${knifeClaims.join('/')}`);

console.log(`\n文档引用腿读数：docs ${s.docs.length} 份 · 解析 ${s.refs} 条 · 认到锚点 ${s.anchored} 条 · 无法定址 ${s.unaddressed} 处 · 台账 ${fakes.length} 把 · 挪一格刀 ${needle ? '有' : '无'}`);
const pre = counters().rows;
ok(pre + 1 === EXPECT_ROWS, `文档引用腿：本闸项数 == 钉死的 ${EXPECT_ROWS} 项（加一条、删一条都要同步这里）`);
const c = run();
process.exit(c.fails ? 1 : 0);
