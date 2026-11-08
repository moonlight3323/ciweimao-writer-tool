'use strict';

/**
 * 界面冒烟测试（jsdom）
 *
 * 目的：在命令行里（起不了 GUI 的环境）真的把 index.html 跑起来，
 * 验证「数据进去 → 界面上的数字对得上」这条链路。
 *
 * 背景：用户反馈「点了星标，优先级作品还是 0」。纯函数测了是对的，
 * 但纯函数对不代表页面上的数字对 —— 中间还有取数、渲染、DOM 写入。
 * 所以这里加载完整页面 + 完整脚本，mock 掉 IPC，直接读 DOM。
 *
 * 约束：
 * - jsdom 用 `npm install --no-save jsdom` 装，不进 devDependencies（否则 CI 的 npm ci 会失败）。
 * - 没装 jsdom 时整组测试跳过，不让主流程红掉。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

let JSDOM = null;
try {
  // eslint-disable-next-line global-require
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  JSDOM = null;
}

/** 真实的 6 本书结构（与 library 索引一致，含 pinned: null 这种老数据） */
const BOOKS = [
  {
    bookId: '100089450', name: '混子薪王与罗德岛', source: 'author', platformBookId: '100089450', chapters: 43, words: 70926, pinned: null,
  },
  {
    bookId: '100419727', name: '人在方舟送快递，怎么成了救世主？', source: 'author', platformBookId: '100419727', chapters: 76, words: 165369, pinned: false, pinnedAt: 0,
  },
  {
    bookId: '100358490', name: '在明日方舟取得白金奖杯吧', source: 'author', platformBookId: '100358490', chapters: 97, words: 199412, pinned: true, pinnedAt: 1794106810105,
  },
  {
    bookId: '100225532', name: '三好薪王立于方舟之上', source: 'author', platformBookId: '100225532', chapters: 759, words: 1690143, pinned: null,
  },
];

/**
 * 兜底桩：任何没显式实现的 api.xxx.yyy 都当成「有个返回 null 的异步函数」。
 *
 * 不这么做的后果很实际：app.js 顶层有几十处 `window.api.xxx.yyy(...)`，
 * 少实现一个就在那一行抛 TypeError，**整个脚本从那里断掉**，
 * 后面的函数声明全都不存在 —— 表现就是「这个也 undefined、那个也没渲染」，
 * 很容易被误判成产品 bug。有了兜底，缺什么只会得到 null，页面照常往下走。
 */
function nullStub() {
  const fn = () => Promise.resolve(null);
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined; // 别被当成 thenable
      return nullStub();
    },
  });
}

/** 把真实实现盖在兜底桩上；缺的路径自动落回 nullStub */
function withFallback(impl, keep) {
  const keys = keep || [];
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) {
        const v = target[prop];
        if (v && typeof v === 'object' && !keys.includes(prop)) {
          return withFallback(v);
        }
        return v;
      }
      return nullStub();
    },
  });
}
function makeApi(seed) {
  const noop = () => Promise.resolve(null);
  const books = JSON.parse(JSON.stringify((seed && seed.books) || BOOKS));
  const snapshots = (seed && seed.snapshots) || null;
  const props = (seed && seed.props) || null;
  const impl = {
    writer: {
      // loadWriterBooks() 会从这里取数据 —— 这是页面真实的取数路径
      list: () => Promise.resolve({ books }),
      priority: () => {
        const hit = books.find((b) => b.pinned === true && b.source !== 'remote'
          && String(b.platformBookId || '').trim());
        return Promise.resolve(hit
          ? { bookId: hit.bookId, platformBookId: hit.platformBookId, name: hit.name, pinnedAt: hit.pinnedAt }
          : null);
      },
      pin: (bookId, pinned) => {
        const b = books.find((x) => String(x.bookId) === String(bookId));
        if (b) { b.pinned = !!pinned; b.pinnedAt = pinned ? Date.now() : 0; }
        return Promise.resolve({ result: { bookId, pinned: !!pinned }, books });
      },
    },
    data: {
      read: (name) => {
        if (name === 'stats-snapshots.json' && snapshots) return Promise.resolve({ snapshots });
        if (name === 'props-snapshots.json' && props) return Promise.resolve({ snapshots: props });
        return Promise.resolve(null);
      },
      write: () => Promise.resolve(true),
      dir: () => Promise.resolve('C:/fake/data'),
      backups: () => Promise.resolve({ root: 'C:/fake/backups', backups: [] }),
      backupNow: () => Promise.resolve({ ok: true }),
      reset: () => Promise.resolve({ ok: true }),
      restore: () => Promise.resolve({ ok: true }),
    },
    app: { relaunch: () => Promise.resolve({ ok: true }), userDataPath: () => Promise.resolve('C:/fake') },
    version: { change: () => Promise.resolve({ ask: false }), resetData: () => Promise.resolve({ ok: true }) },
    storage: { status: () => Promise.resolve({ path: 'C:/fake/data', custom: false }) },
    plugins: { list: () => Promise.resolve({ plugins: [] }) },
    browser: {
      state: () => Promise.resolve({ ready: false, url: '', isLoginPage: true }),
      onEvent: () => () => {},
      evalInPage: noop,
    },
    vault: { status: () => Promise.resolve({ available: true, items: [], file: '' }) },
    // 这几个必须给真数组 / 真对象：页面里是 `await api.xxx.log()` 之后直接取 .length，
    // 落回 nullStub 会得到 null，然后在那一行抛 TypeError 打断 boot()
    exec: { log: () => Promise.resolve([]) },
    ai: { status: () => Promise.resolve({ running: false }) },
    interaction: { status: () => Promise.resolve(null) },
  };
  return withFallback(impl);
}

/**
 * 加载页面。用 file:// + runScripts 让 jsdom 自己按 index.html 的顺序执行脚本，
 * 这样函数声明就和真实浏览器一样落在全局上（用 window.eval 会因为 'use strict'
 * 把函数关在 eval 作用域里，页面上的 renderBoard 反而拿不到）。
 *
 * @returns {{dom, window}|null} 未装 jsdom 时返回 null
 */
function bootPage(seed) {
  if (!JSDOM) return null;
  const file = path.join(RENDERER, 'index.html');
  const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
    url: 'file:///' + file.replace(/\\/g, '/'),
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(window) {
      // 必须在任何脚本执行前准备好 api：app.js 一开头就把它取走了
      window.api = makeApi(seed);
      window.confirm = () => true;
      window.alert = () => {};
      // jsdom 没有 matchMedia，theme.js 在顶层就会用到（跟随系统深浅色）
      window.matchMedia = window.matchMedia || ((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }));
      window.ResizeObserver = window.ResizeObserver || class {
        observe() {} unobserve() {} disconnect() {}
      };
    },
  });
  return { dom, window: dom.window };
}

/** 等页面脚本执行完（jsdom 加载外部脚本是异步的） */
function waitBoot(window, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 8000);
  return new Promise((resolve) => {
    const tick = () => {
      if (typeof window.renderWriterBooks === 'function'
        && typeof window.renderBoard === 'function'
        && typeof window.loadWriterBooks === 'function') return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      return setTimeout(tick, 40);
    };
    tick();
  });
}

/**
 * 轮询等某个条件成立。
 *
 * boot() 里有一串 await，跑完的时机没法从外面精确知道；
 * 与其猜一个固定延时，不如等到界面真的出现预期内容。
 */
function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 6000);
  return new Promise((resolve) => {
    const tick = () => {
      let ok = false;
      try { ok = !!fn(); } catch (_) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      return setTimeout(tick, 40);
    };
    tick();
  });
}

const maybe = JSDOM ? test : test.skip;

maybe('点星标后优先级作品数量立刻变成 1（本次回归的直接复现）', async (t) => {
  // 初始状态：四本书都没点亮，界面显示 0 本
  const unpinned = BOOKS.map((b) => ({ ...b, pinned: false, pinnedAt: 0 }));
  const page = bootPage({ books: unpinned });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();

  const doc = window.document;
  assert.equal(doc.getElementById('writerPinnedCount').textContent, '0', '初始应为 0 本');

  // 点第一本书封面上的星标（走真实的委托监听器，不是直接调函数）
  const pin = doc.querySelector('#writerBookGrid .writer-book-pin');
  assert.ok(pin, '卡片上应有星标按钮');
  pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.ok(await waitFor(() => doc.getElementById('writerPinnedCount').textContent === '1'),
    '点完星标，优先级作品数量应立即变成 1');
  assert.equal(doc.getElementById('writerPinnedPanel').hidden, false, '该栏应自动展开');
  assert.ok(doc.getElementById('writerPinnedGrid').innerHTML.includes('★'), '应显示实心星');
});

maybe('创作中心：优先级作品数量与列表都跟着数据走', async (t) => {
  const page = bootPage();
  assert.ok(page, 'jsdom 应已加载');
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window), '页面脚本应执行完毕');

  assert.equal(typeof window.BookPriority, 'object', 'book-priority.js 应在页面里挂载成功');

  // 走页面真实的取数路径（loadWriterBooks 从 api 取书目并渲染），
  // 不去直接改内部变量：顶层 let 不挂在 window 上，改了也无效。
  await window.loadWriterBooks();
  assert.ok(await waitFor(() => window.document.getElementById('writerPinnedCount').textContent === '1'),
    '优先级作品数量应变成 1');

  const doc = window.document;
  assert.equal(doc.getElementById('writerPinnedBadge').textContent, '1 本');
  assert.equal(doc.getElementById('writerPinnedPanel').hidden, false,
    '有优先级作品时该栏必须显示');

  const pinnedGrid = doc.getElementById('writerPinnedGrid').innerHTML;
  assert.ok(pinnedGrid.includes('在明日方舟取得白金奖杯吧'), '优先级栏里应是点亮的那本');
  assert.ok(pinnedGrid.includes('★'), '点亮状态应渲染成实心星');

  const otherGrid = doc.getElementById('writerBookGrid').innerHTML;
  assert.ok(!otherGrid.includes('在明日方舟取得白金奖杯吧'),
    '优先级作品不能同时出现在其他作品里');
  assert.equal((otherGrid.match(/writer-book-card/g) || []).length, 3, '其他作品应有 3 本');
});

maybe('创作中心：星标渲染在封面里，且样式贴右上角', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  const doc = window.document;
  assert.ok(await waitFor(() => doc.querySelector('#writerBookGrid .writer-book-card')),
    '应渲染出作品卡片');

  const card = doc.querySelector('#writerBookGrid .writer-book-card');
  const cover = card.querySelector('.writer-book-cover');
  assert.ok(cover, '卡片里应有封面容器');
  const pin = cover.querySelector('.writer-book-pin');
  assert.ok(pin, '星标必须放在封面里（才有绝对定位的参照物）');
  const source = cover.querySelector('.writer-book-source');
  assert.ok(source, '来源标签还在');
  assert.equal(pin.parentElement, cover);
  assert.equal(source.parentElement, cover);

  // jsdom 不跑布局，位置只能验样式表：星标靠 right，标签靠 left，两者不同侧
  const css = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
  const pinRule = (css.match(/\.writer-book-pin \{[^}]*\}/) || [''])[0];
  assert.ok(/right:\s*6px/.test(pinRule), '星标应贴右上角（right: 6px）');
  assert.ok(!/\bleft:\s*\d+px/.test(pinRule), '星标不能再贴左边，否则和来源标签重叠');
});

maybe('数据看板：点亮优先级后默认定位到那一本，并排第一', async (t) => {
  const snapshot = {
    day: '2026-11-08',
    capturedAt: new Date().toISOString(),
    totals: {},
    books: BOOKS.map((b) => ({
      bookId: b.bookId, name: b.name, words: b.words, collects: 10,
    })),
  };
  const page = bootPage({ snapshots: [snapshot], books: BOOKS });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  const sel = doc.getElementById('boardBook');
  assert.ok(await waitFor(() => sel.options.length > 1), '查看范围下拉应有书目');
  assert.equal(sel.value, '100358490', '查看范围应自动停在优先级作品上');

  const firstCard = doc.querySelector('#boardBooks .book-card .book-card-name');
  assert.ok(firstCard, '应有作品卡片');
  assert.ok(firstCard.textContent.includes('在明日方舟取得白金奖杯吧'),
    `第一张卡应是优先级作品，实际是 ${firstCard.textContent}`);
});

maybe('数据看板：用户自己选过之后不再被星标抢回去', async (t) => {  const snapshot = {
    day: '2026-11-08',
    capturedAt: new Date().toISOString(),
    totals: {},
    books: BOOKS.map((b) => ({ bookId: b.bookId, name: b.name, words: b.words })),
  };
  const page = bootPage({ snapshots: [snapshot], books: BOOKS });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  const sel = doc.getElementById('boardBook');
  assert.ok(await waitFor(() => sel.options.length > 1), '查看范围下拉应有书目');

  // 模拟用户亲手选一本（触发页面里绑定的 change 处理）
  sel.value = '100089450';
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(sel.value, '100089450', '选完立刻生效');

  // 再画一次也不会被优先级抢回去
  window.renderBoard();
  assert.equal(sel.value, '100089450', '应尊重用户的选择');
});

/* ---------- 侧边栏：草稿 / 保存 / 撤销（本次「没有保存按钮」的回归） ---------- */

/** 侧边栏当前可见项的顺序 */
function visibleNavOrder(doc) {
  return Array.from(doc.querySelectorAll('#nav .nav-item'))
    .filter((b) => !b.classList.contains('is-nav-hidden') && !b.dataset.pluginNav)
    .map((b) => b.dataset.view);
}

/** 侧边栏当前是否处于调整态（▲▼× 是否可见） */
function navEditingOn(window) {
  return window.document.getElementById('nav').classList.contains('is-editing');
}

/** 点一下「调整侧边栏」，进入调整态 */
function clickAdjust(window) {
  window.document.getElementById('btnNavAdjust')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
}

maybe('侧边栏：默认不显示调整按钮，点「调整侧边栏」才出现', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  // 一进来是干净状态：没有 ▲▼×，只有「调整侧边栏」
  assert.equal(navEditingOn(window), false, '默认不该是调整态');
  assert.equal(doc.getElementById('btnNavAdjust').hidden, false, '默认应能看到「调整侧边栏」');
  assert.equal(doc.getElementById('btnNavSave').hidden, true, '默认不该显示保存按钮');

  clickAdjust(window);
  assert.equal(navEditingOn(window), true, '点完应进入调整态');
  assert.equal(doc.getElementById('btnNavAdjust').hidden, true, '进入调整态后「调整侧边栏」应收起');
  assert.equal(doc.getElementById('btnNavSave').hidden, false, '此时应显示保存按钮');
  assert.equal(doc.getElementById('btnNavDiscard').hidden, false, '此时应显示撤销按钮');
});

maybe('侧边栏：上移只改预览，点保存才落盘', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');
  clickAdjust(window);

  const before = visibleNavOrder(doc);
  const saveBtn = doc.getElementById('btnNavSave');
  const discardBtn = doc.getElementById('btnNavDiscard');
  assert.equal(saveBtn.disabled, true, '刚进入、没改动时保存应禁用');
  assert.equal(discardBtn.disabled, true, '刚进入、没改动时撤销应禁用');

  doc.querySelector('#nav .nav-item[data-view="books"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const after = visibleNavOrder(doc);
  assert.notEqual(after.join(','), before.join(','), '侧边栏应立刻按草稿重排（预览）');
  assert.equal(after.indexOf('books'), before.indexOf('books') - 1, '数据看板应上移一位');

  // 关键：还没保存，偏好里不应变
  const savedOrder = window.Prefs.get('navOrder', null);
  assert.notEqual(JSON.stringify(savedOrder || []), JSON.stringify(after),
    '未点保存时不能写进偏好');

  assert.equal(saveBtn.disabled, false, '有改动后保存按钮应可用');
  assert.equal(doc.getElementById('navCustomTag').textContent, '调整中 · 未保存');
});

maybe('侧边栏：保存后写入偏好，且调整按钮全部收起', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');
  clickAdjust(window);

  doc.querySelector('#nav .nav-item[data-view="books"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const previewed = visibleNavOrder(doc);

  doc.getElementById('btnNavSave')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 用 JSON 比较而不是 deepEqual：偏好里的数组来自 jsdom 的 realm
  assert.equal(
    JSON.stringify(window.Prefs.get('navOrder', null)),
    JSON.stringify(previewed),
    '保存后偏好应与预览一致',
  );

  // ★ 本次反馈的核心：保存完按钮必须消失，否则用户以为没生效、还能继续乱动
  assert.equal(navEditingOn(window), false, '保存后必须退出调整态');
  assert.equal(doc.getElementById('btnNavSave').hidden, true, '保存后保存按钮应收起');
  assert.equal(doc.getElementById('btnNavDiscard').hidden, true, '保存后撤销按钮应收起');
  assert.equal(doc.getElementById('btnNavAdjust').hidden, false, '保存后应能再次点「调整侧边栏」');
  assert.equal(doc.getElementById('navCustomTag').textContent, '已自定义');

  // 保存后侧边栏顺序不变（改动已生效）
  assert.equal(visibleNavOrder(doc).join(','), previewed.join(','));
});

maybe('侧边栏：保存后再点 ▲▼× 不会改任何东西', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');
  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="books"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnNavSave')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const settled = visibleNavOrder(doc);
  // 按钮虽然收起了，但节点还在 DOM 里；这时被点到也不该生效
  doc.querySelector('#nav .nav-item[data-view="books"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(visibleNavOrder(doc).join(','), settled.join(','),
    '非调整态下这些按钮不应再起作用');
});

maybe('侧边栏：撤销修改把预览还原并收起按钮', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  const before = visibleNavOrder(doc);
  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="rank"] [data-nav-tool="remove"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(!visibleNavOrder(doc).includes('rank'), '移除后预览里应没有平台榜单');

  doc.getElementById('btnNavDiscard')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(visibleNavOrder(doc).join(','), before.join(','), '撤销后应回到改动前的顺序');
  assert.ok(visibleNavOrder(doc).includes('rank'), '被移除的项应回来');
  assert.equal(navEditingOn(window), false, '撤销后应退出调整态');
});

maybe('侧边栏：恢复初始会回到默认排列，并保持可继续调整', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  // 先自定义一下并保存，制造「非默认」的状态
  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="rank"] [data-nav-tool="remove"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnNavSave')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(!visibleNavOrder(doc).includes('rank'));

  // 点「恢复初始」：立刻回到默认排列
  doc.getElementById('btnNavReset')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const nav = window.NavOrder;
  assert.equal(visibleNavOrder(doc).join(','), nav.defaultOrder().join(','),
    '应恢复成完整默认顺序');
  assert.ok(visibleNavOrder(doc).includes('rank'), '被删掉的项应回来');
  // 用户的原话：「切回恢复默认，又会初始化侧边栏调整」——保持调整态，方便接着调
  assert.equal(navEditingOn(window), true, '恢复初始后应处于调整态，方便继续调整');
  assert.equal(doc.getElementById('btnNavSave').hidden, false, '此时应显示保存按钮');
});

maybe('侧边栏：未保存就离开设置页，改动还原且退出调整态', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.setActiveView('settings');
  const before = visibleNavOrder(doc);
  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="export"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.notEqual(visibleNavOrder(doc).join(','), before.join(','), '预览应已变化');

  window.setActiveView('overview');
  assert.equal(visibleNavOrder(doc).join(','), before.join(','),
    '离开设置页应丢掉未保存的草稿');
  assert.equal(navEditingOn(window), false, '离开设置页应退出调整态');
});

maybe('侧边栏：保存 / 撤销 / 恢复初始都在本页给出可见反馈', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  const flash = doc.getElementById('navFlash');

  window.setActiveView('settings');
  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="books"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  doc.getElementById('btnNavSave')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(flash.hidden, false, '保存后应出现可见提示');
  assert.ok(flash.textContent.includes('已保存'), `提示文案应说明已保存，实际：${flash.textContent}`);
  assert.equal(flash.classList.contains('is-error'), false);

  doc.getElementById('btnNavReset')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(flash.textContent.includes('初始'), `恢复初始应有提示，实际：${flash.textContent}`);

  // 提示元素必须在设置面板里，用户才看得到
  assert.ok(doc.getElementById('panelNav').contains(flash),
    '提示行必须放在侧边栏设置面板内部');
});

/* ---------- 道具获得：已合并进数据看板，版式照作者后台 ---------- */

/** 造一份道具快照 */
function propsSnap(day, bookId, items) {
  return {
    day, bookId, bookName: 'B', capturedAt: `${day}T08:00:00Z`,
    items, detail: [], raw: [], scanned: 30,
  };
}

maybe('道具获得就在数据看板里，不再是独立页面', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  const section = doc.getElementById('propsSection');
  assert.ok(section, '道具区块必须存在');
  const board = doc.querySelector('section.view[data-view="books"]');
  assert.ok(board.contains(section),
    '道具区块必须嵌在「数据看板」视图里，而不是单独一页');

  // 侧边栏里不能再有「道具收获」这一项
  const navViews = Array.from(doc.querySelectorAll('#nav .nav-item')).map((b) => b.dataset.view);
  assert.equal(navViews.includes('props'), false, '侧边栏不该再有独立入口');
  assert.equal(doc.querySelector('section.view[data-view="props"]'), null,
    '独立的道具页应该已经删掉');
});

maybe('道具四张卡按平台的顺序与名称排列', async (t) => {
  const page = bootPage({ books: BOOKS });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  window.renderProps();

  const doc = window.document;
  const labels = Array.from(doc.querySelectorAll('#propsGrid .props-label'))
    .map((n) => n.textContent.trim());
  assert.deepEqual(labels, ['总推荐票', '总月票', '总打赏', '总刀片'],
    '顺序与名称必须与「统计中心 → 道具获得」一致');
  assert.equal(labels.includes('宝箱'), false, '平台没有宝箱这一项');
});

maybe('道具数字与前一天差值都渲染出来', async (t) => {
  const snapshots = [
    propsSnap('2026-11-07', '100358490', { recommend: 10, monthly: 5, reward: 300, blade: 1 }),
    propsSnap('2026-11-08', '100358490', { recommend: 12, monthly: 5, reward: 280, blade: 4 }),
  ];
  // 让统计日就是 2026-11-08，避免测试随真实日期漂移
  const page = bootPage({ books: BOOKS, snapshots: [], props: snapshots, today: '2026-11-08' });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');
  assert.ok(await waitFor(() => {
    const cards = window.document.querySelectorAll('#propsGrid .props-card');
    return cards.length === 4 && !cards[0].querySelector('.props-value').textContent.includes('—');
  }), '道具卡片应带着快照里的数字渲染出来');

  const doc = window.document;
  const values = Array.from(doc.querySelectorAll('#propsGrid .props-value'))
    .map((n) => n.textContent.trim());
  assert.deepEqual(values, ['12', '5', '280', '4'], '四项数字应按平台顺序显示');

  const diffs = Array.from(doc.querySelectorAll('#propsGrid .props-diff'))
    .map((n) => n.textContent.trim());
  assert.ok(diffs[0].includes('+2'), `推荐票应比前一日 +2，实际：${diffs[0]}`);
  assert.ok(diffs[1].includes('±0'), `月票持平，实际：${diffs[1]}`);
  assert.ok(diffs[2].includes('-20'), `打赏应比前一日 -20，实际：${diffs[2]}`);
  assert.ok(diffs[3].includes('+3'), `刀片应比前一日 +3，实际：${diffs[3]}`);
});

maybe('没有前一天数据时不显示 ±0，而是「首次读取」', async (t) => {
  const page = bootPage({ books: BOOKS, props: [propsSnap('2026-11-08', '100358490', { recommend: 7 })] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');
  assert.ok(await waitFor(() => {
    const cards = window.document.querySelectorAll('#propsGrid .props-card');
    return cards.length === 4 && !cards[0].querySelector('.props-value').textContent.includes('—');
  }), '道具卡片应带着快照里的数字渲染出来');

  const diff = window.document.querySelector('#propsGrid .props-diff').textContent;
  assert.ok(diff.includes('首次'), `应提示首次读取，实际：${diff}`);
  assert.equal(diff.includes('±0'), false, '没有对比基准时绝不能显示 ±0');
});

maybe('趋势图按粒度切换，图例四个色块', async (t) => {
  const snapshots = [];
  for (let d = 1; d <= 8; d++) {
    snapshots.push(propsSnap(`2026-11-0${d}`, '100358490', {
      recommend: d * 10, monthly: d, reward: d * 100, blade: d,
    }));
  }
  const page = bootPage({ books: BOOKS, props: snapshots });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');
  assert.ok(await waitFor(() => window.document.querySelectorAll('#propsLegend .props-legend-item').length === 4));

  const doc = window.document;
  const legend = Array.from(doc.querySelectorAll('#propsLegend .props-legend-item'))
    .map((n) => n.textContent.trim());
  assert.deepEqual(legend, ['推荐票', '月票', '打赏', '刀片'], '图例顺序与平台一致');

  // 近 7 日：11-02 ~ 11-08，应只有 7 个点
  assert.ok(doc.querySelector('#propsChartCanvas svg'), '应画出 SVG 折线图');
  const dots7 = doc.querySelectorAll('#propsChartCanvas svg circle').length;
  assert.ok(dots7 > 0, '图上应有点');

  // 切到近 30 日：8 天全进窗口，点应更多
  doc.querySelector('#propsGrain [data-grain="30"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const dots30 = doc.querySelectorAll('#propsChartCanvas svg circle').length;
  assert.ok(dots30 > dots7, `近30日应比近7日多出点，7日=${dots7} 30日=${dots30}`);
});

maybe('明细为空时说明「平台本期没有」，不画成错误', async (t) => {
  const page = bootPage({ books: BOOKS, props: [propsSnap('2026-11-08', '100358490', { recommend: 1 })] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');
  assert.ok(await waitFor(() => window.document.getElementById('propsDetailBody').textContent.trim().length > 0));

  const body = window.document.getElementById('propsDetailBody');
  assert.ok(body.textContent.includes('没有'), `应说明平台本期没有明细，实际：${body.textContent}`);
  assert.equal(body.querySelector('table'), null, '没有数据时不该画空表');
});

maybe('明细有数据时按平台表格画出来', async (t) => {
  const snap = propsSnap('2026-11-08', '100358490', { recommend: 1 });
  snap.detail = [
    { cols: ['时间', '读者', '道具', '数量'], cells: ['11-08 09:12', '某读者', '推荐票', '3'] },
    { cols: ['时间', '读者', '道具', '数量'], cells: ['11-08 10:30', '另一位', '刀片', '1'] },
  ];
  const page = bootPage({ books: BOOKS, props: [snap] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');
  assert.ok(await waitFor(() => window.document.querySelector('#propsDetailBody table')));

  const doc = window.document;
  const rows = doc.querySelectorAll('#propsDetailBody tbody tr');
  assert.equal(rows.length, 2, '两行明细');
  const head = doc.querySelector('#propsDetailBody thead th');
  assert.equal(head.textContent.trim(), '时间', '表头应取自平台表格');
});
maybe('道具区块默认跟着优先级作品，不被下拉的第一项抢走', async (t) => {
  // 这条锁的是个真 bug：下拉一旦填上选项，浏览器就默认选第一项，
  // 于是「没选过就跟随优先级作品」永远轮不到执行 ——
  // 表现是点亮了星标，道具区块却盯着另一本书。
  const propsSnapshots = [
    propsSnap('2026-11-08', '100358490', { recommend: 99 }),   // 优先级作品的数据
    propsSnap('2026-11-08', '100089450', { recommend: 7 }),    // 第一本的数据
  ];
  const page = bootPage({ books: BOOKS, props: propsSnapshots });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');

  const doc = window.document;
  assert.equal(doc.getElementById('propsBook').value, '100358490',
    '默认应停在优先级作品（BOOKS 里 pinned 的那本），而不是列表第一项');
  const value = doc.querySelector('#propsGrid .props-value').textContent.trim();
  assert.equal(value, '99', `卡片应显示优先级作品的数据，实际 ${value}`);
});

maybe('用户手动换作品后，固定看这一本', async (t) => {
  const propsSnapshots = [
    propsSnap('2026-11-08', '100358490', { recommend: 99 }),
    propsSnap('2026-11-08', '100089450', { recommend: 7 }),
  ];
  const page = bootPage({ books: BOOKS, props: propsSnapshots });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');

  const doc = window.document;
  const sel = doc.getElementById('propsBook');
  sel.value = '100089450';
  sel.dispatchEvent(new window.Event('change'));

  assert.equal(doc.getElementById('propsBook').value, '100089450');
  assert.equal(doc.querySelector('#propsGrid .props-value').textContent.trim(), '7',
    '换成另一本后应显示那一本的数据');
});

