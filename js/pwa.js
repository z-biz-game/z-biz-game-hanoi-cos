// 可安装性接线。三条不抛异常的路径，对应三种真实宿主：
//
//   file://            双击 index.html 玩（Electron 不用这条路，它走本地 http origin）。
//                      Service Worker 在没有 origin 时注册必然 reject，Chrome 还会往控制台补一条
//                      uncaught rejection —— 本仓的验收线把控制台干净算作红，所以这里直接不注册，
//                      并把状态报给 HUD：「本地打开，不能离线」。
//   非安全 http        （局域网里 http://192.168.x.x）：navigator.serviceWorker 是 undefined，
//                      同样只报告不注册。
//   https / localhost  正常注册；`beforeinstallprompt` 到手就把它交给 HUD 的安装按钮，
//                      不让浏览器自己弹那个横幅。
//
// 注册失败（离线缓存被策略拒、配额满）也只更新状态文本，不 throw：游戏本身零依赖网络。

const SECURE = () => {
  if (typeof location === 'undefined') return false;
  return location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
};

export function pwaSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && SECURE();
}

export function setupPwa(onStatus) {
  const report = (status, detail = '') => {
    if (typeof onStatus === 'function') onStatus({ status, detail });
    return status;
  };
  let deferred = null;

  if (typeof location === 'undefined' || location.protocol === 'file:') return report('file', '本地打开 · 不注册 Service Worker');
  if (!pwaSupported()) return report('insecure', '非安全上下文 · 不注册 Service Worker');

  const ready = navigator.serviceWorker.register('./sw.js', { scope: './' })
    .then((reg) => {
      report('ready', `离线壳已装 · ${reg.active ? '已激活' : '等待激活'}`);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => { if (nw.state === 'activated') report('ready', '离线壳已更新'); });
      });
      return reg;
    })
    .catch((err) => report('failed', err && err.name ? err.name : String(err)));

  if (typeof window !== 'undefined') {
    window.addEventListener('beforeinstallprompt', (ev) => {
      ev.preventDefault();
      deferred = ev;
      report('installable', '可以装到桌面 / 主屏');
    });
    window.addEventListener('appinstalled', () => { deferred = null; report('installed', '已安装为独立窗口'); });
  }

  return {
    ready,
    // HUD 上「安装」按钮的唯一入口：没有 prompt 事件（已安装、或 iOS Safari 不支持）时返回 false，
    // 由调用方决定退回什么文案 —— iOS 的添加主屏没有可编程入口。
    async promptInstall() {
      if (!deferred) return false;
      const ev = deferred;
      deferred = null;
      ev.prompt();
      const choice = await ev.userChoice.catch(() => ({ outcome: 'dismissed' }));
      report('installable', `用户选择：${choice.outcome}`);
      return choice.outcome === 'accepted';
    },
  };
}

export default setupPwa;
