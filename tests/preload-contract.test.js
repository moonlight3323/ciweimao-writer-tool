'use strict';

/**
 * 桥接契约：用 preload 的**真实结构**驱动一次页面加载
 *
 * 这个测试是「到处都点不动」那类事故的最终守门人。
 *
 * 起因：preload 里 `exposeInMainWorld('api', {...})` 出现了两个 `app:` 键，
 * 后一个把前一个整块覆盖，`window.api.app.closeBehavior` 变成 undefined。
 * 于是 app.js 顶层 `initCloseBehavior()` 抛 TypeError，**从那一行往后全部不执行**：
 *   - `initCloseAskDialog()` 没跑 → 右上角关闭按钮点了没反应
 *   - `$('#btnTheme').addEventListener` 没跑 → 深色模式点了没反应
 *   - `let guideFallback` 没初始化 → 之后弹窗抛 TDZ 错误 → 清除数据点了没弹窗
 *   - 末尾的 `boot()` 没跑 → 看板、道具都不渲染
 * 四个症状，一个根因。
 *
 * 单个断言看不出这类问题，所以这里换一种做法：
 * **按 preload 源码解析出真实的方法清单，构造一个「一个多余的都没有」的严格 api**，
 * 然后真的点按钮。preload 少一个方法，页面就会在这里崩掉，测试立刻红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const PRELOAD_SRC = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');

let JSDOM = null;
let VirtualConsole = null;
try {
  // eslint-disable-next-line global-require
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (_) {
  JSDOM = null;
}

/**
 * 从 preload 源码解析出 `{ 域名: [方法名...] }`。
 *
 * 只认 exposeInMainWorld 里那一层的写法：`  域名: {` 开始，`    name: … ` 收集方法名。
 * 不做通用 JS 解析，够用且不会因为格式漂移而误判 —— 解析不到就断言失败，
 * 逼着人回来看这个函数，而不是静默放过。
 */
function parseBridge(src) {
  const start = src.indexOf("exposeInMainWorld('api'");
  assert.ok(start >= 0, 'preload 里应有 exposeInMainWorld(\'api\', …)');
  const lines = src.slice(start).split('\n');
  const out = {};
  let domain = null;
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*\{/.exec(trimmed);
      if (m) {
        domain = m[1];
        // 同名域名写了两遍时，后一个会整体覆盖前一个 —— 这里必须照 JS 语义清空重来，
        // 否则「重复 app 键」这种事故在解析结果里看不出来（会两边方法都算上）
        out[domain] = [];
      }
    } else if (depth === 2 && domain) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(trimmed);
      if (m) out[domain].push(m[1]);
    }

    depth += opens - closes;
    if (depth === 1 && domain && closes > 0) {
      // 域名块结束（回到 exposeInMainWorld 那一层）
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*\{/.exec(trimmed);
      if (!m) domain = null;
    }
    if (depth <= 0 && Object.keys(out).length) break;
  }
  return out;
}

/** 严格 mock：preload 有什么就只给什么，缺的就是 undefined（不走 Proxy 兜底） */
function strictApi(bridge) {
  const ok = () => Promise.resolve(null);
  /** 少数几个必须返回可用数据结构的方法，否则页面在正常路径上就断了 */
  const realValues = {
    'data.read': () => Promise.resolve(null),
    'data.write': () => Promise.resolve(true),
    'data.backups': () => Promise.resolve({ root: 'C:/backup', backups: [] }),
    'browser.state': () => Promise.resolve({ ready: false, url: '', isLoginPage: true }),
    'browser.onEvent': () => () => {},
    'vault.status': () => Promise.resolve({ available: true, items: [], file: '' }),
    'exec.log': () => Promise.resolve([]),
    'plugins.list': () => Promise.resolve({ plugins: [] }),
    'storage.status': () => Promise.resolve({ path: 'C:/f', custom: false }),
    'app.closeBehavior.get': () => Promise.resolve({ value: 'minimize' }),
    'app.closeBehavior.set': (v) => Promise.resolve({ value: v }),
    'app.onCloseBehaviorChanged': () => () => {},
    'app.onAskCloseBehavior': () => () => {},
  };

  const api = {};
  for (const [domain, methods] of Object.entries(bridge)) {
    api[domain] = {};
    for (const m of methods) {
      api[domain][m] = realValues[`${domain}.${m}`] || ok;
    }
    // 有的方法本身是对象而不是函数（比如 app.closeBehavior）。
    // 只要解析到的清单里有它，就按 realValues 里的点号键展开成嵌套对象；
    // **清单里没有就不给** —— 这正是要测的场景（重复 app 键会让它消失）。
    for (const m of methods) {
      const nestedPrefix = `${domain}.${m}.`;
      const nestedKeys = Object.keys(realValues)
        .filter((k) => k.startsWith(nestedPrefix));
      if (!nestedKeys.length) continue;
      const obj = {};
      for (const k of nestedKeys) obj[k.slice(nestedPrefix.length)] = realValues[k];
      api[domain][m] = obj;
    }
  }
  return api;
}

const maybe = JSDOM ? test : test.skip;

maybe('preload 暴露的每个域名都能解析出方法', () => {
  const bridge = parseBridge(PRELOAD_SRC);
  for (const [domain, methods] of Object.entries(bridge)) {
    assert.ok(methods.length > 0, `域名 ${domain} 下没解析到方法，解析逻辑可能失效`);
  }
  // 这几个域名必须存在，否则页面一定崩
  for (const need of ['app', 'browser', 'data', 'vault', 'exec', 'plugins']) {
    assert.ok(bridge[need], `preload 必须暴露 ${need}`);
  }
});

maybe('按 preload 真实结构加载页面：关键按钮全部能响应', async () => {
  const bridge = parseBridge(PRELOAD_SRC);
  const api = strictApi(bridge);

  const file = path.join(RENDERER, 'index.html');
  const vc = new VirtualConsole();
  const errors = [];
  vc.on('jsdomError', (e) => {
    const msg = (e.detail && e.detail.message) || e.message;
    // 网络类噪声不算：这个测试只关心脚本执行
    if (/Not implemented|Could not load/i.test(msg)) return;
    errors.push(msg);
  });

  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    url: 'file:///' + file.replace(/\\/g, '/'),
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      window.api = api;
      window.confirm = () => true;
      window.alert = () => {};
      window.matchMedia = () => ({
        matches: false,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      });
      window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    },
  });

  try {
    // 等脚本加载完（boot 是 async，给足时间）
    await new Promise((r) => setTimeout(r, 1500));
    const { window } = dom;
    const doc = window.document;

    // 脚本加载阶段不应该有未捕获错误
    assert.deepEqual(errors, [], `页面脚本执行出错：${errors.join(' | ')}`);

    // ★ 1. 窗口分段（曾因 closeBehavior 为 undefined 而完全不响应）
    const seg = doc.getElementById('closeBehaviorSeg');
    assert.ok(seg, '应有窗口分段控件');
    seg.querySelector('[data-close-behavior="quit"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(seg.querySelector('.is-active').dataset.closeBehavior, 'quit',
      '点「直接退出」应切换选中态');

    // ★ 2. 深色模式（绑定在 initCloseBehavior 之后，曾整段没执行）
    const root = doc.documentElement;
    const beforeTheme = root.dataset.theme;
    doc.getElementById('btnTheme')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    assert.notEqual(root.dataset.theme, beforeTheme, '点深色模式应切换主题');

    // ★ 3. 清除所有数据（曾因 guideFallback 未初始化抛 TDZ）
    window.setActiveView('settings');
    doc.getElementById('btnDataReset')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(doc.getElementById('guideDialog').hidden, false,
      '点「清除所有数据」应弹出确认框');

    // ★ 4. 关闭询问的监听必须注册上（决定右上角关闭按钮是否弹框）
    assert.equal(typeof api.app.onAskCloseBehavior, 'function',
      'app.onAskCloseBehavior 必须存在，否则关闭按钮点了没反应');

    // 脚本加载完后再检查一次，确保上面的交互没引出新异常
    assert.deepEqual(errors, [], `交互过程中出错：${errors.join(' | ')}`);
  } finally {
    dom.window.close();
  }
});
