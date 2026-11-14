'use strict';

/**
 * 喵语数据站（第三方）内嵌控制。
 *
 * 站点本身是 Vue + hash 路由的纯前端应用，内容全在 /ciweimao 下：
 *   /ciweimao/firstRecommend  试水推榜
 *   /ciweimao/sd              万收首订
 * 首页只有登录引导与空广告位、/wap 与桌面版重复，因此这里只放行 /ciweimao/*，
 * 其余路由一律拨回试水推，并把站点自己的「首页」菜单项隐藏掉。
 *
 * 抽成模块而不是塞在 main.js 里，是为了能脱离整个应用单独起窗口跑回归测试。
 */

const { WebContentsView, session, shell } = require('electron');
const { themeSource } = require('../shared/miaoyu-skin');

const ORIGIN = 'http://newmmm.yukirus.com';
const PARTITION = 'persist:miaoyu';
const ROUTES = {
  firstRecommend: '#/ciweimao/firstRecommend',
  sd: '#/ciweimao/sd',
};
const HOME = ORIGIN + '/' + ROUTES.firstRecommend;

/**
 * 访问节流。
 *
 * 喵语是一个人维护的小站，社区提醒「多几个用户一起轮询就能把它打爆」。
 * 实测（2026-11-05）它的前端自身**没有轮询**：加载完 16 个请求就静止，
 * 数据按周（试水推）/按期（首卖）更新，本来也不需要实时刷新。
 *
 * 因此这里定两条硬规矩，改动前请先想清楚：
 *   1. 绝不为喵语做自动刷新/定时抓取；用户不点，就不发请求。
 *   2. 万一日后真需要后台刷新，间隔不得低于 1 小时（MIN_AUTO_REFRESH_MS）。
 */
const MIN_AUTO_REFRESH_MS = 60 * 60 * 1000;
/** 同一页签重复点击的复用窗口：这段时间内不重新加载整页 */
const SAME_ROUTE_REUSE_MS = 10 * 60 * 1000;
/** 手动刷新的冷却：防连点，一次整页加载对这小站已经不轻 */
const MANUAL_REFRESH_COOLDOWN_MS = 30 * 1000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 从 hash 路由里取路径部分：…/#/ciweimao/sd → /ciweimao/sd */
function routeOf(url) {
  const m = String(url || '').match(/#(\/[^?]*)/);
  return m ? m[1] : '';
}

/** 只认 /ciweimao 下的页面 */
function isAllowed(url) {
  return /^\/ciweimao(\/|$)/.test(routeOf(url));
}

function isHost(url) {
  return /^https?:\/\/(newmmm|cwmsj)\.yukirus\.com(\/|$)/i.test(String(url || ''));
}

/**
 * 隐藏站点自己的「首页」菜单。
 * 数据都在刺猬猫栏目下，首页只有登录引导与空广告位，留着会误导。
 */
const TIDY = `(function () {
  if (window.__wbTidy) return 'already';
  window.__wbTidy = true;

  // 两件事都是为了让七列数据能完整显示：
  // 1) 站点自带的左侧导航（logo + 首页/刺猬猫菜单）宽 250px，和本应用的导航重复，
  //    切换功能已由应用自己的页签承接，这里直接让出宽度；
  // 2) 站点把主容器写死了 min-width:1280px，窗口窄于这个值右侧几列会被直接裁掉
  //    （不是出现滚动条）。解除限制后靠 flex 自适应，1:1 比例就能放下。
  var css = 'aside.menu-main,.menu-main{display:none !important}'
    + '#app > div{display:block !important}'
    + '.main-page{min-width:0 !important;width:100% !important}'
    + '.main-content{min-width:0 !important;padding-left:0 !important;padding-right:0 !important}'
    + '.page-head{padding-left:14px !important;padding-right:14px !important}';
  var st = document.getElementById('wb-tidy-style');
  if (!st) {
    st = document.createElement('style');
    st.id = 'wb-tidy-style';
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  }
  return 'ok';
})()`;

/**
 * @param {Object} opts
 * @param {Function} opts.getWindow     返回宿主 BrowserWindow
 * @param {Function} opts.broadcast     向渲染进程发事件
 * @param {Function} opts.canGoBack
 * @param {Function} opts.canGoForward
 */
function createMiaoyu(opts) {
  const o = opts || {};
  const getWindow = o.getWindow || (() => null);
  const broadcast = o.broadcast || (() => {});
  const canGoBack = o.canGoBack || (() => false);
  const canGoForward = o.canGoForward || (() => false);
  const goBack = o.goBack || (() => false);
  const goForward = o.goForward || (() => false);

  /** @type {WebContentsView|null} */
  let view = null;
  let attached = false;
  /** 最近一次整页加载完成的时间（用于避免重复请求与界面提示） */
  let loadedAt = 0;
  /** 路由守卫最近几次拨回的时刻；10 秒窗口内超过 3 次就判定为循环 */
  let guardHits = [];
  /** 判定循环后锁住自动拨回，等用户手动导航/刷新再解除 */
  let guardStopped = false;
  /** 主界面当前主题：{ dark, colors }。默认浅色，等渲染层推过来 */
  let theme = { dark: false, colors: {} };

  function applyThemeOn(wc) {
    if (!wc || wc.isDestroyed()) return;
    wc.executeJavaScript(themeSource(theme), true).catch(() => {});
  }

  function ensure() {
    if (view && !view.webContents.isDestroyed()) return view;

    view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(PARTITION),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    const wc = view.webContents;
    wc.setUserAgent(UA);

    const pushState = () => {
      const url = wc.getURL();
      broadcast({
        type: 'miaoyu-state',
        url,
        route: routeOf(url),
        loading: wc.isLoading(),
        canGoBack: canGoBack(wc),
        canGoForward: canGoForward(wc),
        loadedAt,
      });
    };

    // 路由守卫：不属于 /ciweimao 的页面一律拨回试水推。
    //
    // 必须限次：如果站点把 HOME 本身重定向到 /login，loadURL(HOME) 会再次
    // 触发 did-navigate → guard → loadURL(HOME)，形成无限整页重载 ——
    // 这正是本模块最想避免的「把第三方小站打爆」。10 秒内拨回超过 3 次
    // 就锁住自动守卫，把状态交给界面，等用户手动点刷新/切页签再解除。
    const guard = () => {
      const url = wc.getURL();
      if (!url) return;
      if (isHost(url) && isAllowed(url)) return;
      if (guardStopped) return;
      const now = Date.now();
      guardHits = guardHits.filter((t) => now - t < 10000);
      guardHits.push(now);
      if (guardHits.length > 3) {
        guardStopped = true;
        broadcast({
          type: 'miaoyu-error',
          code: 'redirect-loop',
          desc: '站点反复跳到非数据页，已停止自动重定向',
          url,
        });
        return;
      }
      wc.loadURL(HOME);
    };

    wc.on('dom-ready', () => {
      wc.executeJavaScript(TIDY, true).catch(() => {});
      // 页面重建（刷新/切页签）时样式会丢，这里补一次；浅色主题下是空操作
      applyThemeOn(wc);
    });
    // 首屏数据是异步拉的，等表格渲染出来再量宽度
    wc.on('did-finish-load', () => {
      loadedAt = Date.now();
      pushState();
      setTimeout(() => {
        if (!wc.isDestroyed()) fitZoom(wc);
      }, 1200);
    });
    // 站内切页（试水推 ↔ 万收首订）是 hash 变化，只会走 did-navigate-in-page，
    // 不会重新加载文档。所以加载时间在这里也要记，否则「数据加载于」会一直停在首屏那次。
    wc.on('did-navigate', () => { guard(); loadedAt = Date.now(); pushState(); });
    wc.on('did-navigate-in-page', () => { guard(); loadedAt = Date.now(); pushState(); });
    wc.on('did-start-loading', pushState);
    wc.on('did-stop-loading', pushState);

    wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      broadcast({ type: 'miaoyu-error', code, desc, url });
    });

    // 站内链接留在当前视图，站外交给系统浏览器
    wc.setWindowOpenHandler(({ url }) => {
      if (isHost(url)) { wc.loadURL(url); return { action: 'deny' }; }
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });

    return view;
  }

  /**
   * 按可视宽度自适应缩放。
   *
   * 正常情况下 TIDY 里放宽了站点的最小宽度，1:1 就能放下七列。
   * 这个函数只是兜底：窗口被拉到很窄（视图宽度 < 约 900）时仍有溢出，
   * 就按比例缩小，保证右列不被裁掉；窗口拉宽后会还原到 1 倍。
   */
  async function fitZoom(wc) {
    if (!wc || wc.isDestroyed()) return 1;
    try {
      // 先在 1 倍下量一次真实需求宽度
      wc.setZoomFactor(1);
      await new Promise((r) => setTimeout(r, 150));
      const raw = await wc.executeJavaScript(
        '(function(){var d=document.documentElement;'
        + 'return JSON.stringify({sw:d.scrollWidth,cw:d.clientWidth});})()',
        true
      );
      const m = JSON.parse(raw);
      if (!m || !m.cw || !m.sw) return 1;
      if (m.sw <= m.cw + 4) return 1;
      // 多留 1% 余量，避免滚动条临界抖动
      const z = Math.max(0.6, Math.min(1, (m.cw / m.sw) * 0.99));
      if (z < 0.995) wc.setZoomFactor(z);
      return z;
    } catch (_) {
      return 1;
    }
  }

  /** bounds 变化足够大时才重算缩放，避免拖动窗口时反复重排 */
  let lastWidth = 0;
  let fitTimer = null;
  function scheduleFit() {
    if (!view || view.webContents.isDestroyed()) return;
    if (Math.abs((lastWidth || 0) - currentWidth) < 40 && lastWidth) return;
    lastWidth = currentWidth;
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      if (view && !view.webContents.isDestroyed()) fitZoom(view.webContents);
    }, 260);
  }
  let currentWidth = 0;

  function applyBounds(rect) {
    if (!view || !attached) return;
    const r = rect || {};
    currentWidth = Math.max(1, Math.round(r.width ?? 800));
    scheduleFit();
    view.setBounds({
      x: Math.max(0, Math.round(r.x ?? 0)),
      y: Math.max(0, Math.round(r.y ?? 0)),
      width: Math.max(1, Math.round(r.width ?? 800)),
      height: Math.max(1, Math.round(r.height ?? 600)),
    });
  }

  function detach() {
    const win = getWindow();
    if (!view || !win || !attached) return;
    win.contentView.removeChildView(view);
    attached = false;
    // 页面留在内存里（再次进入不必重新拉整页），但要让它彻底闲下来。
    // 注：试过 CDP 的 Page.setWebLifecycleState('frozen')，会让 Electron 的
    // 网络进程直接崩掉，所以只用官方的后台节流，不做激进冻结。
    try { view.webContents.setBackgroundThrottling(true); } catch (_) { /* ignore */ }
  }

  function attach(rect) {
    const v = ensure();
    const win = getWindow();
    if (!win) return v;
    if (!attached) {
      win.contentView.addChildView(v);
      attached = true;
    }
    applyBounds(rect);
    return v;
  }

  async function open(rect) {
    const v = attach(rect);
    const wc = v.webContents;
    guardStopped = false;
    guardHits = [];
    if (!wc.getURL()) await wc.loadURL(HOME);
    return { url: wc.getURL() };
  }

  async function goto(which) {
    const v = ensure();
    const hash = ROUTES[which] || ROUTES.firstRecommend;
    const target = ORIGIN + '/' + hash;
    const now = wxNow();
    // 用户主动切页签：允许守卫重新工作
    guardStopped = false;
    guardHits = [];

    // 已经在同一页、且加载不久：直接复用，别为一次点击再拉一遍整页。
    // 小站经不起反复刷；数据本身也是按周/按期更新的。
    if (routeOf(v.webContents.getURL()) === routeOf(target)
        && loadedAt && now - loadedAt < SAME_ROUTE_REUSE_MS) {
      return { skipped: true, url: v.webContents.getURL(), loadedAt };
    }

    await v.webContents.loadURL(target);
    return { skipped: false, url: v.webContents.getURL(), loadedAt: Date.now() };
  }

  function wxNow() { return Date.now(); }

  function state() {
    if (!view || view.webContents.isDestroyed()) {
      return { ready: false, url: '', route: '', canGoBack: false, canGoForward: false, loadedAt: 0 };
    }
    const wc = view.webContents;
    const url = wc.getURL();
    return {
      ready: true,
      url,
      route: routeOf(url),
      loading: wc.isLoading(),
      canGoBack: canGoBack(wc),
      canGoForward: canGoForward(wc),
      attached,
      loadedAt,
    };
  }

  function destroy() {
    if (!view) return;
    try { view.webContents.close(); } catch (_) { /* ignore */ }
    view = null;
    attached = false;
  }

  return {
    open,
    attach,
    detach,
    applyBounds,
    goto,
    reload: () => {
      const v = ensure();
      if (loadedAt && Date.now() - loadedAt < MANUAL_REFRESH_COOLDOWN_MS) {
        return { skipped: true, loadedAt };
      }
      guardStopped = false;
      guardHits = [];
      v.webContents.reload();
      return { skipped: false, loadedAt: Date.now() };
    },
    back: () => {
      guardStopped = false;
      guardHits = [];
      return goBack(ensure().webContents);
    },
    forward: () => {
      guardStopped = false;
      guardHits = [];
      return goForward(ensure().webContents);
    },
    external: () => {
      const url = view && !view.webContents.isDestroyed() ? view.webContents.getURL() : HOME;
      shell.openExternal(url || HOME);
      return true;
    },
    /** 渲染层每次切主题都会推一份；深色时覆盖站点配色，浅色时恢复原样 */
    setTheme: (next) => {
      theme = {
        dark: !!(next && next.dark),
        colors: (next && next.colors) || {},
      };
      if (view && !view.webContents.isDestroyed()) applyThemeOn(view.webContents);
      return { ok: true, dark: theme.dark };
    },
    state,
    destroy,
    // 便于测试
    MIN_AUTO_REFRESH_MS,
    SAME_ROUTE_REUSE_MS,
    fitZoom: () => (view && !view.webContents.isDestroyed() ? fitZoom(view.webContents) : Promise.resolve(1)),
    getView: () => view,
    isAttached: () => attached,
  };
}

module.exports = {
  createMiaoyu, routeOf, isAllowed, isHost, ORIGIN, HOME, ROUTES, PARTITION, TIDY,
  themeSource,
  MIN_AUTO_REFRESH_MS, SAME_ROUTE_REUSE_MS, MANUAL_REFRESH_COOLDOWN_MS,
};
