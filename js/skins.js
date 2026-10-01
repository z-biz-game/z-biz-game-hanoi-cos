// 位图皮肤：把 assets/gen/make_art.py 产出的纹理与 sprite 装进画布。
//
// 为什么还要位图，明明盘面全是程序化画的：程序化渐变给不了「物质感」——石头的颗粒、
// 铜的受光面。三张图各管一件事，且都留了程序化回落：
//   stone-512  可平铺石材 → base beam 与舞台底（createPattern + repeat）
//   glow-256   径向发光 sprite → 提示高亮与认证解的落点光（drawImage，替代 shadowBlur）
//   grain-128  细颗粒 → 舞台背景叠一遍（低 alpha，不参与任何动画）
//
// 装载是异步的，而本仓的验收线有一条「两帧指纹必须相同」的静止对照：图片在两次采样中间
// 到达会让那条断言假红。所以解码完成时只重画一帧（onReady），并且 isMoving() 在装载期间
// 保持 false —— 装载不是动画。

const SOURCES = {
  stone: 'assets/art/stone-512.png',
  glow: 'assets/art/glow-256.png',
  grain: 'assets/art/grain-128.png',
};

export function createSkins(onReady = () => {}) {
  const imgs = {};
  const patterns = new Map();
  let loaded = 0;

  for (const key of Object.keys(SOURCES)) {
    if (typeof Image !== 'function') break; // 无 DOM 的环境（node 台架）：直接走程序化回落
    const im = new Image();
    im.decoding = 'async';
    im.addEventListener && im.addEventListener('error', () => { im.__failed = true; });
    im.onload = () => {
      loaded++;
      patterns.delete(key);
      onReady(key);
    };
    im.src = SOURCES[key];
    imgs[key] = im;
  }

  const live = (key) => {
    const im = imgs[key];
    return !!im && !im.__failed && im.complete && im.naturalWidth > 0 ? im : null;
  };

  return {
    // 只有真的到位图才返回对象；调用方据此在「位图皮肤」与「程序化底」之间二选一。
    img: live,
    count: () => loaded,
    sources: SOURCES,
    pattern(ctx, key, repetition = 'repeat') {
      const im = live(key);
      if (!im || typeof ctx.createPattern !== 'function') return null;
      if (!patterns.has(key)) {
        const p = ctx.createPattern(im, repetition);
        if (!p) return null;
        patterns.set(key, p);
      }
      return patterns.get(key);
    },
    // 发光 sprite 画成一个以 (x,y) 为中心、宽 w 高 h 的暖光。没有图就退回 CSS 里那套
    // shadowBlur —— 视觉差一点，但一张空白的画布比一个略平的铜盘好排查。
    glow(ctx, x, y, w, h, alpha = 1) {
      const im = live('glow');
      if (!im || alpha <= 0) return false;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      ctx.drawImage(im, x - w / 2, y - h / 2, w, h);
      ctx.restore();
      return true;
    },
  };
}

export default createSkins;
