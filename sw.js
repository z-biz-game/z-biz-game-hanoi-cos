// 离线壳。三条硬约定，都是踩出来的：
//
// 1) 缓存名带版本号，activate 时把不是当前版本的缓存整份删掉。VERSION 只用来命名存储桶，
//    不用来钉内容 —— 见下一条。
// 2) 同源子资源一律**网络优先、失败退缓存**。手工版本号 + cache-first 会把 js/css 永久钉死在
//    旧版，出新 HTML 配旧 JS 的鬼状态比没有 SW 更糟。
// 3) install 里不做 addAll 预取清单：这个仓的模块图会长（js/core/* 现在就有 6 个），清单一旦
//    漂移，一次 404 就让 install 拒绝、页面控制台报错，而本仓的验收线把「控制台干净」算作红。
//    按需缓存（成功即写）覆盖同一个离线目标，且没有这个失败模式。
//
// file:// 下这段代码根本不会被装载：js/pwa.js 在没有 http origin 时不注册。

const VERSION = 'hanoi-v1';
const CACHE = `hanoi-${VERSION}`;
const SHELL = './index.html';

const sameOriginGet = (req) => {
  if (req.method !== 'GET') return false;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return false;
  }
  return url.origin === self.location.origin;
};

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = (req, res) => caches.open(CACHE).then((c) => c.put(req, res.clone()));

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  if (!sameOriginGet(req)) return;
  const isNav = req.mode === 'navigate' || (req.destination === 'document' && !/\.(js|css|png|json|webmanifest)$/.test(new URL(req.url).pathname));

  ev.respondWith(
    fetch(req)
      .then((res) => {
        // 只存 200：一次 500 或 304 写进缓存，等于把故障固化成离线内容。
        if (res && res.ok && res.type === 'basic') ev.waitUntil(put(req, res));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => {
        if (hit) return hit;
        // 离线的导航请求：回到壳，让 hash 路由在本地把题面重建出来（盘面数字全在 js/data 里，
        // 不需要服务器），而不是给用户一个浏览器的离线错误页。
        if (isNav) return caches.match(SHELL).then((shell) => shell || Response.error());
        return Response.error();
      })),
  );
});
