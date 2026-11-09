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
  const seedPlugins = (seed && seed.plugins) || null;
  const browserListeners = [];
  const repairImpl = (seed && seed.repair) || null;
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
    plugins: {
      // 默认返回空列表 + 没有可补装的东西：多数测试不关心功能中心
      list: (seedPlugins ? () => Promise.resolve({ plugins: seedPlugins }) : () => Promise.resolve({ plugins: [] })),
      repair: (repairImpl || (() => Promise.resolve({ installed: [], plugins: [] }))),
    },
    browser: {
      state: () => Promise.resolve({ ready: false, url: '', isLoginPage: true }),
      // 把回调存起来，测试可以主动推一条 browser-state 进去
      onEvent: (fn) => { browserListeners.push(fn); return () => {}; },
      evalInPage: noop,
    },
    vault: { status: () => Promise.resolve({ available: true, items: [], file: '' }) },
    // 这几个必须给真数组 / 真对象：页面里是 `await api.xxx.log()` 之后直接取 .length，
    // 落回 nullStub 会得到 null，然后在那一行抛 TypeError 打断 boot()
    exec: { log: () => Promise.resolve([]) },
    ai: { status: () => Promise.resolve({ running: false }) },
    interaction: { status: () => Promise.resolve(null) },
    // 测试用它主动推浏览器状态事件
    __browserListeners: browserListeners,
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

maybe('创作中心：星标挂在卡片上，封面怎么塌都点得到', async (t) => {
  // 用户反馈：给「没读到封面」的书加星之后，卡片塌成一条，星标也不见了，取消不了。
  // 根因是星标当时放在 .writer-book-cover 里，而封面 overflow:hidden、
  // 高度完全由封面图决定 —— 图挂了就是 0 高，星标被裁掉。
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
  const pin = card.querySelector('.writer-book-pin');
  assert.ok(pin, '卡片上应有星标');
  assert.equal(pin.parentElement, card, '星标必须直接挂在卡片上');
  assert.equal(pin.closest('.writer-book-cover'), null,
    '星标不能放在封面里 —— 封面 overflow:hidden，高度塌了星标就点不到');

  // 来源标签仍在封面里（它不需要点击，被裁掉也只是不好看）
  const source = cover.querySelector('.writer-book-source');
  assert.ok(source, '来源标签还在');

  // jsdom 不跑布局，位置只能验样式表：星标靠 right，标签靠 left，两者不同侧。
  // 卡片 padding 8px（配 -8px 外边距），所以 14px 正好是离封面边 6px。
  const css = fs.readFileSync(path.join(RENDERER, 'style.css'), 'utf8');
  const pinRule = (css.match(/\.writer-book-pin \{[^}]*\}/) || [''])[0];
  assert.ok(/right:\s*14px/.test(pinRule), '星标应贴封面右上角（卡片内 right: 14px）');
  assert.ok(/top:\s*14px/.test(pinRule), '星标应贴封面右上角（卡片内 top: 14px）');
  assert.ok(!/\bleft:\s*\d+px/.test(pinRule), '星标不能再贴左边，否则和来源标签重叠');

  // 封面本身要有高度下限，任何情况下都不该塌成 0
  const coverRule = (css.match(/\n\.writer-book-cover \{[^}]*\}/) || [''])[0];
  assert.ok(/min-height:\s*\d+px/.test(coverRule), '封面容器要有 min-height 兜底');
});

maybe('加星后能取消：优先级栏里的星标照样点得动', async (t) => {
  // 用户反馈的第二半：「而且还会没法取消星标」。
  // 星标被裁在 0 高的封面里，点不到；这里是防回归 —— 进了优先级栏也必须能取消。
  const unpinned = BOOKS.map((b) => ({ ...b, pinned: false, pinnedAt: 0 }));
  const page = bootPage({ books: unpinned });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();

  const doc = window.document;
  const pin = doc.querySelector('#writerBookGrid .writer-book-pin');
  pin.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(await waitFor(() => doc.getElementById('writerPinnedCount').textContent === '1'));

  const pinnedPin = doc.querySelector('#writerPinnedGrid .writer-book-pin');
  assert.ok(pinnedPin, '优先级栏里必须有星标按钮（不然取消不了）');
  pinnedPin.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(await waitFor(() => doc.getElementById('writerPinnedCount').textContent === '0'),
    '点优先级栏里的星标应能取消');
  const back = doc.querySelector('#writerBookGrid .writer-book-pin');
  assert.ok(back, '取消后应回到其他作品');
  assert.equal(back.closest('.writer-book-cover'), null,
    '星标不在封面里，封面塌了也点得到');
});

maybe('封面加载失败退回渐变占位，优先级栏里的也不例外', async (t) => {
  // 原来兜底只绑了 #writerBookGrid。书一加星就挪进优先级栏，
  // 那张坏掉的封面从此没人管 —— 容器停在 0 高，卡片塌成一条白条。
  const books = [
    { ...BOOKS[0], pinned: false, pinnedAt: 0, cover: 'https://example.invalid/a.jpg' },
    { ...BOOKS[2], pinned: true, pinnedAt: 1794106810105, cover: 'https://example.invalid/b.jpg' },
  ];
  const page = bootPage({ books });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();

  const doc = window.document;
  assert.ok(await waitFor(() => doc.querySelector('#writerPinnedGrid .writer-book-cover-img')),
    '优先级栏应渲染出封面图');

  const pinnedImg = doc.querySelector('#writerPinnedGrid .writer-book-cover-img');
  const pinnedCover = pinnedImg.closest('.writer-book-cover');
  const otherImg = doc.querySelector('#writerBookGrid .writer-book-cover-img');
  const otherCover = otherImg.closest('.writer-book-cover');

  // 渲染时绝不能先打 has-cover：那会把「无封面时的 3:4 占位」关掉，
  // 图一旦挂掉高度就是 0 —— 这正是卡片塌陷的成因。
  assert.equal(pinnedCover.classList.contains('has-cover'), false,
    '图还没加载完，不能先打 has-cover');
  assert.equal(otherCover.classList.contains('has-cover'), false);

  // 加载成功 → 按图片自身比例撑开
  otherImg.dispatchEvent(new window.Event('load'));
  assert.equal(otherCover.classList.contains('has-cover'), true, '加载成功后按真实比例');

  // 加载失败 → 退回渐变占位，破图摘掉
  pinnedImg.dispatchEvent(new window.Event('error'));
  assert.equal(pinnedCover.classList.contains('has-cover'), false, '失败后不能留 has-cover');
  assert.equal(doc.querySelector('#writerPinnedGrid .writer-book-cover-img'), null,
    '坏图要摘掉，别留破图占位');
});

maybe('数据看板：概览默认停在全部作品，优先级那本排第一并带星标', async (t) => {
  // 概览 = 一行一本的作品卡（六指标网格），点卡进详情，不自动跳单本。
  // 优先级作品的体现：排在第一个 + 实心星。
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
  assert.equal(sel.value, '', '默认应停在「全部作品」，不再自动跳进单本');

  const cards = doc.querySelectorAll('#boardBooks .book-card');
  assert.ok(cards.length >= 4, `概览应列出所有作品，实际 ${cards.length} 张卡`);
  assert.ok(cards[0].textContent.includes('在明日方舟取得白金奖杯吧'),
    `优先级作品应在第一张，实际是 ${cards[0].textContent.trim().slice(0, 30)}`);
  assert.equal(cards[0].classList.contains('is-priority'), true, '第一张应标记为优先级');
  assert.equal(cards[0].querySelector('.book-card-star').textContent.trim(), '★',
    '优先级作品应显示实心星');
  // 非优先级的那几张是空心星，一眼能看出差别
  assert.equal(cards[1].querySelector('.book-card-star').textContent.trim(), '☆');
});

maybe('数据看板：BookPriority 没加载时排序也不许静默失效', async (t) => {
  // 用户看到的真实现象：「星标亮着，那本却排在第三行」。
  // 只要排序依赖的全局对象缺失，排序就会被跳过，界面上完全看不出原因。
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

  const saved = window.BookPriority;
  try {
    window.BookPriority = undefined;
    window.renderBoard();
    const cards = window.document.querySelectorAll('#boardBooks .book-card');
    assert.ok(cards[0].textContent.includes('在明日方舟取得白金奖杯吧'),
      `没有 BookPriority 时也要把标星的排第一，实际是 ${cards[0].textContent.trim().slice(0, 30)}`);
  } finally {
    window.BookPriority = saved;
  }
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

maybe('侧边栏：恢复初始回到默认排列，并结束调整（不再显示 ▲▼×）', async (t) => {
  // 用户报的问题：点「恢复初始」后顺序确实变回默认了，但 ▲▼× 又出现在每一项上、
  // 标签写着「调整中」，看起来像没恢复干净。恢复初始必须是一次性动作：
  // 落盘默认顺序 + 退出调整态。想接着调就再点一次「调整侧边栏」。
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
  assert.equal(navEditingOn(window), false, '保存后本来就已退出调整态');

  // 点「恢复初始」：回到默认排列，并结束调整
  doc.getElementById('btnNavReset')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const nav = window.NavOrder;
  assert.equal(visibleNavOrder(doc).join(','), nav.defaultOrder().join(','),
    '应恢复成完整默认顺序');
  assert.ok(visibleNavOrder(doc).includes('rank'), '被删掉的项应回来');

  assert.equal(navEditingOn(window), false, '恢复初始后必须退出调整态');
  assert.equal(doc.querySelector('#nav').classList.contains('is-editing'), false,
    '侧边栏不能残留 is-editing（那会让 ▲▼× 继续显示）');
  assert.equal(doc.getElementById('btnNavSave').hidden, true, '不该再显示保存按钮');
  assert.equal(doc.getElementById('btnNavDiscard').hidden, true, '不该再显示撤销按钮');
  assert.equal(doc.getElementById('btnNavAdjust').hidden, false, '应回到「调整侧边栏」按钮');
  assert.equal(doc.getElementById('btnNavReset').hidden, false, '应回到「恢复初始」按钮');
  assert.ok(doc.getElementById('navCustomTag').textContent.includes('默认'),
    `标签应显示默认排列，实际：${doc.getElementById('navCustomTag').textContent}`);
  assert.equal(window.Prefs.get('navOrder', []).join(','), nav.defaultOrder().join(','),
    '默认顺序必须已经落盘');
});

maybe('侧边栏：调整中点恢复初始也一并结束调整', async (t) => {
  // 调整态下这个按钮是隐藏的，但状态机不能指望「按钮不可见」来兜底：
  // 万一以后把它挪出来，点了也必须回到干净状态。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="miaoyu"] [data-nav-tool="down"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(navEditingOn(window), true);

  doc.getElementById('btnNavReset')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(navEditingOn(window), false, '恢复初始应结束调整态');
  assert.equal(visibleNavOrder(doc).join(','), window.NavOrder.defaultOrder().join(','),
    '顺序应回到默认');
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


/* ---------- 弹窗遮挡：内嵌平台页面会盖住 DOM 弹窗 ---------- */

maybe('清除数据 / 恢复数据 / 继承旧数据三个弹窗前会先摘下内嵌页面', async (t) => {
  // v1.0.6 修过一次「内嵌网页挡住更新窗口」，这次新增的三个确认框是同一类场景：
  // 作者后台是 WebContentsView，画在渲染页面之上，不先摘下来用户什么也看不见。
  const page = bootPage({ books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  // 用假的钩子替代真实实现，只关心「有没有调用」
  let prepared = 0;
  let restored = 0;
  let detachResult = true;
  window.prepareUpdateOverlay = async () => {
    prepared += 1;
    return detachResult ? { browser: true, miaoyu: false } : null;
  };
  window.restoreUpdateOverlay = async () => { restored += 1; };

  window.setActiveView('settings');
  // 直接调三处的共同入口，等价于用户点了那些按钮
  await window.showBlockingDialog({
    badge: '危险操作',
    title: '清除所有数据并重启？',
    steps: ['会被清除：作品库'],
    secondary: { label: '先不清除' },
    primary: { label: '清除并重启' },
  });

  assert.equal(prepared, 1, '弹窗出现前应先摘掉内嵌页面');
  assert.equal(doc.getElementById('guideDialog').hidden, false, '弹窗应已显示');

  // 关闭后要把页面挂回去
  doc.querySelector('#guideActions .btn.ghost')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('guideDialog').hidden, true, '弹窗应已关闭');
  assert.equal(restored, 1, '关闭后应把页面挂回');
});

maybe('没有内嵌页面时不必摘取，也不做多余的恢复', async (t) => {
  const page = bootPage({ books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  let prepared = 0;
  let restored = 0;
  window.prepareUpdateOverlay = async () => { prepared += 1; return null; };
  window.restoreUpdateOverlay = async () => { restored += 1; };

  window.setActiveView('settings');
  await window.showBlockingDialog({
    badge: '版本升级',
    title: '要不要接着用旧版本的数据？',
    steps: ['继承：全部保留'],
    secondary: { label: '不继承' },
    primary: { label: '继承旧数据' },
  });

  assert.equal(prepared, 1, '仍会问一次（由实现判断有没有页面）');
  doc.querySelector('#guideActions .btn.ghost')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(restored, 0, '本来就没有摘取，不该调恢复（避免把用户关掉的页面又弹出来）');
});

maybe('摘取失败也要让弹窗出来，不能把用户卡死', async (t) => {
  const page = bootPage({ books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.prepareUpdateOverlay = async () => { throw new Error('摘不下来'); };
  window.restoreUpdateOverlay = async () => {};

  window.setActiveView('settings');
  await window.showBlockingDialog({
    badge: '危险操作',
    title: '清除所有数据并重启？',
    steps: ['x'],
    secondary: { label: '取消' },
    primary: { label: '确定' },
  });
  assert.equal(doc.getElementById('guideDialog').hidden, false,
    '即使摘取失败，弹窗也必须显示出来');
});

/* ---------- 功能中心：内置功能不见了要能自己回来 ---------- */

const BUNDLED = [
  { id: 'pomodoro', name: '番茄钟', version: '1.0.0', enabled: true, invalid: false, builtin: true, permissions: [], contributes: { floatingWidget: true } },
  { id: 'health-helper', name: '健康提醒', version: '1.1.0', enabled: true, invalid: false, builtin: true, permissions: [], contributes: {} },
  { id: 'income-calculator', name: '稿费计算器', version: '1.2.0', enabled: true, invalid: false, builtin: true, permissions: [], contributes: {} },
];

maybe('功能中心：列表为空时自动补装内置功能，不用重启', async (t) => {
  // 用户真实处境：清除数据失败后没有重启，data/plugins 已被清空，
  // 于是功能中心空着，而他没有任何「重装内置功能」的入口。
  let repaired = 0;
  const page = bootPage({
    plugins: [],
    repair: () => {
      repaired += 1;
      // 主进程补装后把新的完整列表一起返回
      return Promise.resolve({ installed: ['pomodoro', 'health-helper', 'income-calculator'], plugins: BUNDLED });
    },
  });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  await window.loadPlugins();

  // 启动流程本身也可能已经触发过一次自愈，所以只要求「发生过」，
  // 真正要保证的是补装结果被渲染出来
  assert.ok(repaired >= 1, '列表为空时应自动请求补装');
  const cards = doc.querySelectorAll('#pluginGrid .plugin-card');
  assert.equal(cards.length, 3, `补装后应有 3 张功能卡，实际 ${cards.length}`);
  assert.ok(doc.getElementById('pluginGrid').innerHTML.includes('番茄钟'));
  assert.ok(doc.getElementById('pluginGrid').innerHTML.includes('健康提醒'));
  assert.ok(doc.getElementById('pluginGrid').innerHTML.includes('稿费计算器'));

  // 空态提示要收起来，否则「有卡片 + 说它是空的」自相矛盾
  assert.equal(doc.getElementById('pluginEmpty').hidden, true, '有功能时空态应隐藏');
});

maybe('功能中心：本来就有功能时不去打扰主进程', async (t) => {
  let repaired = 0;
  const page = bootPage({
    plugins: BUNDLED,
    repair: () => { repaired += 1; return Promise.resolve({ installed: [], plugins: BUNDLED }); },
  });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadPlugins();
  assert.equal(repaired, 0, '功能都在时不该调 repair');
  assert.equal(window.document.querySelectorAll('#pluginGrid .plugin-card').length, 3);
});

maybe('功能中心：补装也补不出东西时，明确告诉用户要重启', async (t) => {
  const page = bootPage({
    plugins: [],
    repair: () => Promise.resolve({ installed: [], plugins: [] }),
  });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  await window.loadPlugins();

  // 空态应显示，且不出现空白的「已恢复」提示
  assert.equal(doc.getElementById('pluginEmpty').hidden, false, '真的没有功能时应显示空态');
  const notice = doc.getElementById('pluginNotice');
  assert.equal(/已自动恢复/.test(notice.textContent), false, '没装到东西不能说已恢复');
});

maybe('「重新加载」会补装内置功能并说明补了哪些', async (t) => {
  let repaired = 0;
  const page = bootPage({
    plugins: BUNDLED,
    repair: () => { repaired += 1; return Promise.resolve({ installed: ['income-calculator'], plugins: BUNDLED }); },
  });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  await window.loadPlugins();
  repaired = 0; // 只看按钮这一次

  doc.getElementById('btnPluginReload')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await waitFor(() => repaired === 1);

  assert.equal(repaired, 1, '「重新加载」必须顺带请求补装');
  assert.ok(await waitFor(() => /已补装内置功能/.test(doc.getElementById('pluginNotice').textContent)),
    '补装了就要说清楚补了什么');
});

/* ---------- 首次登录引导：只有真的登录成功才弹 ---------- */

/**
 * 模拟「用户已经点过首次声明卡片的『我知道了』」。
 *
 * 声明卡片开着时 maybeShowAfterLoginGuide 会主动让路（两个弹层抢同一个位置），
 * 而真实用户走到登录这一步时卡片早就关了。测试不处理这个就会一直看到「没弹」。
 */
function dismissFreeNotice(window) {
  const el = window.document.getElementById('freeNotice');
  if (el) el.hidden = true;
}

/** 往页面推一条浏览器状态事件 */
function pushBrowserState(window, state) {
  const listeners = (window.api && window.api.__browserListeners) || [];
  for (const fn of listeners) {
    fn({ type: 'browser-state', isLoading: false, canGoBack: false, canGoForward: false, ...state });
  }
}

maybe('刚点「打开作者后台」还没登录，不能弹「登录成功」', async (t) => {
  // 用户报的问题：点「打开作者后台」→ 页面开始加载 homepage
  // → 第二个弹窗「接下来抓一次评论」当场弹出，还把后台关掉了，
  // 用户根本没机会登录。
  // 原因：老判断只看「当前不是登录页」，而 homepage 本来就不含 /login。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.Prefs.set('guideAfterLoginShown', false);
  window.setActiveView('overview');
  dismissFreeNotice(window);

  // 1) 刚开始加载，URL 还是空的
  pushBrowserState(window, { url: '', isLoginPage: false });
  assert.equal(doc.getElementById('guideDialog').hidden, true, '空 URL 时不该弹窗');

  // 2) 停在后台首页（未登录时平台会随后重定向到登录页）
  pushBrowserState(window, { url: 'https://author.ciweimao.com/homepage', isLoginPage: false });
  assert.equal(doc.getElementById('guideDialog').hidden, true,
    '仅仅打开后台首页不等于登录成功，不能弹「接下来抓一次评论」');
  assert.equal(window.Prefs.get('guideAfterLoginShown', false), false,
    '误判时也不能把「已看过」标记写上，否则用户再也看不到正确的引导');

  // 3) 页面重定向到登录页
  pushBrowserState(window, { url: 'https://author.ciweimao.com/login/index', isLoginPage: true });
  assert.equal(doc.getElementById('guideDialog').hidden, true, '登录页上不该弹');
});

maybe('真的登录成功后，才弹「接下来抓一次评论」', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.Prefs.set('guideAfterLoginShown', false);
  window.setActiveView('overview');
  dismissFreeNotice(window);

  // 完整链路：后台首页 → 登录页 → 登录后回后台
  pushBrowserState(window, { url: 'https://author.ciweimao.com/homepage', isLoginPage: false });
  pushBrowserState(window, { url: 'https://author.ciweimao.com/login/index', isLoginPage: true });
  assert.equal(doc.getElementById('guideDialog').hidden, true, '还在登录页');

  pushBrowserState(window, { url: 'https://author.ciweimao.com/homepage', isLoginPage: false });

  assert.equal(doc.getElementById('guideDialog').hidden, false,
    '登录成功后应弹出「接下来抓一次评论」');
  assert.ok(doc.getElementById('guideDialog').textContent.includes('接下来抓一次评论'));
  assert.equal(window.Prefs.get('guideAfterLoginShown', false), true,
    '正常弹出后才写标记');
});

maybe('登录后的加载中间态不弹，等停下来再弹', async (t) => {
  // 重定向过程中会有一堆 isLoading 的中间状态，这时候弹窗很容易被打断
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.Prefs.set('guideAfterLoginShown', false);
  window.setActiveView('overview');
  dismissFreeNotice(window);

  pushBrowserState(window, { url: 'https://author.ciweimao.com/login/index', isLoginPage: true });
  pushBrowserState(window, {
    url: 'https://author.ciweimao.com/homepage', isLoginPage: false, isLoading: true,
  });
  assert.equal(doc.getElementById('guideDialog').hidden, true, '加载中不弹');

  pushBrowserState(window, {
    url: 'https://author.ciweimao.com/homepage', isLoginPage: false, isLoading: false,
  });
  assert.equal(doc.getElementById('guideDialog').hidden, false, '加载完成后弹');
});

maybe('喵语数据等其它站点不算登录成功', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.Prefs.set('guideAfterLoginShown', false);
  window.setActiveView('overview');
  dismissFreeNotice(window);

  pushBrowserState(window, { url: 'https://author.ciweimao.com/login/index', isLoginPage: true });
  // 不是作者后台的域
  pushBrowserState(window, { url: 'https://newmmm.yukirus.com/ciweimao/sd', isLoginPage: false });
  assert.equal(doc.getElementById('guideDialog').hidden, true,
    '只有作者后台才算「登录完成」，第三方数据站不算');
});

maybe('引导只弹一次：标记写过就不再打扰', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  window.setActiveView('overview');
  window.Prefs.set('guideAfterLoginShown', false);
  dismissFreeNotice(window);

  pushBrowserState(window, { url: 'https://author.ciweimao.com/login/index', isLoginPage: true });
  pushBrowserState(window, { url: 'https://author.ciweimao.com/homepage', isLoginPage: false });
  assert.equal(doc.getElementById('guideDialog').hidden, false);
  doc.querySelector('#guideActions .btn.ghost')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 再走一遍同样的链路
  pushBrowserState(window, { url: 'https://author.ciweimao.com/login/index', isLoginPage: true });
  pushBrowserState(window, { url: 'https://author.ciweimao.com/homepage', isLoginPage: false });
  assert.equal(doc.getElementById('guideDialog').hidden, true, '不该第二次弹出来');
});

/* ---------- 创作中心提示条：不能赖着不走，自动任务也不能占用它 ---------- */

maybe('提示条一定会自己消失，「读取完成」不会一直挂着', async (t) => {
  // 用户报的问题：创作中心顶部那条「读取完成：6 本 共 1254 章…」一直在，消不掉。
  // 原因：writerNotice 的 autoHideMs 默认是 0（永不消失），而它没有关闭按钮。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  const notice = doc.getElementById('writerNotice');

  // 1) 默认值必须是个正数（不传第三个参数时也不能常驻）
  const ttl = window.writerNotice('读取完成：6 本共 1254 章；另有 6 本本地已有正文，未覆盖');
  assert.ok(ttl > 0, `一次性结果提示的默认停留时间必须 > 0，实际 ${ttl}`);
  assert.equal(notice.hidden, false, '刚发出来时应可见');
  assert.ok(notice.textContent.includes('读取完成'));

  // 2) 错误提示停留更久（给用户看清的时间）但也不能常驻
  const errTtl = window.writerNotice('同步失败：请先登录作者后台', true);
  assert.ok(errTtl > ttl, '错误提示应比普通提示停得久');
  assert.equal(notice.classList.contains('is-error'), true, '错误提示要有错误样式');

  // 3) 真的能消失：用一个小值实测行为，不必硬等 6 秒
  window.writerNotice('读完了', false, 120);
  assert.ok(await waitFor(() => notice.hidden === true, 2000),
    '定时到点后必须自己隐藏，否则就是关不掉的弹窗');
});

maybe('显式传 0 才会常驻（保留给需要盯住的情况）', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  const notice = doc.getElementById('writerNotice');

  const ttl = window.writerNotice('这条要盯着', false, 0);
  assert.equal(ttl, 0);
  assert.equal(notice.hidden, false);
});

maybe('自动同步不会把「正在读取章节」写进提示条', async (t) => {
  // 另一条报告：「从零开始打开这个页面，就有一个弹窗显示正在读取章节，卡死不动」。
  // 根因是登录后自动跑的 syncWriterBoundBooks 把进度回调接到了 writerNotice，
  // 而 1254 章要读好几分钟，界面看起来就是卡死。
  const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const start = src.indexOf('async function syncWriterBoundBooks');
  assert.ok(start > 0, '应能找到 syncWriterBoundBooks');
  const body = src.slice(start, src.indexOf('async function syncWriterRemoteBook'));

  assert.ok(!/pullWriterBookNewChapters\([^)]*writerNotice\)/.test(body),
    '自动同步不能把 writerNotice 当进度回调：它会把后台任务刷到用户眼前');
  assert.ok(/pullWriterBookNewChapters\([^)]*\(\) => \{\}\)/.test(body),
    '自动同步应传空回调，只在结束时汇总一次');
});

maybe('手动同步仍然显示逐章进度（这条不能被上面那条误伤）', async (t) => {
  const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const start = src.indexOf('async function syncWriterRemoteBook');
  const body = src.slice(start, start + 600);
  assert.ok(body.includes('pullWriterBookChapters(remote, writerNotice)'),
    '用户亲手点的「同步」要看得到进度，否则不知道卡在哪');
});

/* ---------- 数据看板：概览 / 详情两级 ---------- */

function boardSnapshot() {
  return {
    day: '2026-11-08',
    capturedAt: new Date().toISOString(),
    totals: {},
    books: BOOKS.map((b) => ({
      bookId: b.bookId, name: b.name, words: b.words, collects: 10,
    })),
  };
}

maybe('概览页恢复成一行一本的作品卡：六项指标网格 + 整卡可点', async (t) => {
  // 用户要求：列表那种「四个小数字挤在右边」的排布退回去，
  // 恢复之前每本一张卡、六项指标对齐的排布，但保留「点一下进详情」。
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  assert.equal(doc.getElementById('boardBooks').hidden, false, '概览应显示作品卡');
  assert.equal(doc.querySelectorAll('#boardList .board-row').length, 0,
    '旧的单行列表应当移除，不要两套排布并存');

  const cards = doc.querySelectorAll('#boardBooks .book-card');
  assert.equal(cards.length, BOOKS.length, '一本一张卡');
  assert.equal(cards[0].querySelectorAll('.metric').length, 6, '概览卡同样是六项指标');
  const labels = Array.from(cards[0].querySelectorAll('.metric-label')).map((n) => n.textContent.trim());
  assert.deepEqual(labels, ['总字数', '收藏', '新增订阅', '章节均订', '总订阅', '日均追订']);

  // 概览卡可点（不是纯展示），且带「详情 ›」提示
  assert.equal(cards[0].classList.contains('is-clickable'), true, '概览卡应可点进详情');
  assert.equal(cards[0].getAttribute('role'), 'button', '可点的卡要有 role=button');
  assert.ok(cards[0].querySelector('.book-card-go'), '概览卡头上应有「详情 ›」');

  // 返回按钮在概览态不出现
  assert.equal(doc.getElementById('btnBoardBack').hidden, true);
});

maybe('单击作品卡进入详情：完整指标 + 其他指标 + 趋势图 + 道具获得', async (t) => {
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  const card = doc.querySelector('#boardBooks .book-card.is-clickable');
  const bookId = card.dataset.book;
  card.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 顶层 let 不挂在 window 上，只能从 DOM 观察结果
  assert.equal(doc.querySelectorAll('#boardBooks .book-card').length, 1, '详情只画当前这本');
  assert.equal(doc.querySelector('#boardBooks .book-card').classList.contains('is-clickable'), false,
    '详情卡不该还能再点');

  const metrics = doc.querySelectorAll('#boardBooks .book-card .metric');
  assert.equal(metrics.length, 6, '详情页保留六项完整指标');

  // 道具获得是单本数据，详情页必须合并进来
  assert.equal(doc.getElementById('propsSection').hidden, false, '详情页应显示道具获得');
  assert.equal(doc.getElementById('btnBoardBack').hidden, false, '详情页应有返回按钮');

  // 下拉也跟着同步，避免两块 UI 说不同的话
  assert.equal(doc.getElementById('boardBook').value, bookId);
});

maybe('概览卡也认键盘：Enter / Space 都能进详情', async (t) => {
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  const card = doc.querySelector('#boardBooks .book-card.is-clickable');
  const bookId = card.dataset.book;
  card.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  assert.equal(doc.querySelectorAll('#boardBooks .book-card').length, 1, 'Enter 应进详情');
  assert.equal(doc.getElementById('boardBook').value, bookId);
});

maybe('概览态完全隐藏道具获得（它是某一本书的数据）', async (t) => {
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  assert.equal(window.document.getElementById('propsSection').hidden, true,
    '全部作品模式下不该出现道具获得');
});

maybe('详情页的返回按钮回到全部作品，并重新铺出作品卡', async (t) => {
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  doc.querySelector('#boardBooks .book-card.is-clickable')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.querySelectorAll('#boardBooks .book-card').length, 1, '先确认已经进了详情');

  doc.getElementById('btnBoardBack')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(doc.querySelectorAll('#boardBooks .book-card').length, BOOKS.length,
    '返回后应回到全部作品的作品卡');
  assert.equal(doc.getElementById('btnBoardBack').hidden, true, '返回按钮自己也该收起');
  assert.equal(doc.getElementById('propsSection').hidden, true, '道具获得随详情一起收起');
  assert.equal(doc.getElementById('boardBook').value, '');
});

maybe('详情页标题旁也显示优先级星标', async (t) => {
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  window.renderBoard();

  const doc = window.document;
  // 优先级那本排在第一个，点进去
  doc.querySelector('#boardBooks .book-card.is-clickable')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const card = doc.querySelector('#boardBooks .book-card');
  assert.ok(card.classList.contains('is-priority'), '详情卡应带优先级标记');
  const star = card.querySelector('.book-card-star');
  assert.equal(star.textContent.trim(), '★', '标题旁应有实心星');
  // 平台状态标签还在，没有因为加星标被挤掉
  assert.ok(card.querySelector('.book-card-name'), '书名仍在');
  // 详情卡还显示订阅最高的章节（概览卡这里是「详情 ›」）
  assert.ok(card.querySelector('.book-card-chapter'), '详情卡应显示订阅最高章节');
});

maybe('道具区块跟着详情页的书走，不会停在上一次选的书', async (t) => {
  const props = [
    propsSnap('2026-11-08', '100358490', { recommend: 99 }),
    propsSnap('2026-11-08', '100089450', { recommend: 7 }),
  ];
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  await window.loadWriterBooks();
  await window.refreshPriorityInfo();
  await window.loadPropsSnapshots();
  window.__setPropsToday('2026-11-08');
  window.renderBoard();

  const doc = window.document;
  // 点第二张卡（非优先级那本）进详情
  const cards = doc.querySelectorAll('#boardBooks .book-card.is-clickable');
  const targetId = cards[1].dataset.book;
  cards[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(doc.getElementById('propsBook').value, targetId,
    '道具区块选中的书应跟着详情页走');
});

maybe('进数据看板必定重新读一次优先级，不吃过期缓存', async (t) => {
  // 用户报过「创作中心点了星标，数据看板还是原来的顺序」。
  // 只靠启动时查一次的缓存，一旦过期就会一直错下去。
  let asked = 0;
  const page = bootPage({ snapshots: [boardSnapshot()], books: BOOKS, props: [] });
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));

  const original = window.api.writer.priority;
  window.api.writer.priority = async () => { asked += 1; return original(); };

  await window.ensureBoardReady();
  assert.ok(asked >= 1, '进看板应重新查一次优先级');
});

/* ---------- 平台榜单：抓取失败 / 卡住时 button 必须恢复 ---------- */

maybe('榜单抓取失败后按钮恢复可用，不留「抓取中…」', async (t) => {
  // 用户报的问题：点刷新后卡在「抓取中…」、「正在抓取榜单页…」，一直没有结果。
  // 根因是主进程的 net.fetch 没有超时，Promise 永不 settle，finally 就不执行，
  // 按钮永久禁用 —— 只能重启软件。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('rank');

  // 模拟主进程抛错（超时被翻译成可读错误之后就是这种形态）
  window.api.rank = { fetch: () => Promise.reject(new Error('请求超时（12 秒无响应）')) };

  doc.getElementById('btnRefreshRank')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.ok(await waitFor(() => doc.getElementById('btnRefreshRank').disabled === false),
    '失败后按钮必须恢复，否则用户只能重启软件');

  assert.equal(doc.getElementById('btnRefreshRank').textContent, '刷新榜单');
  const notice = doc.getElementById('rankNotice');
  assert.equal(notice.classList.contains('is-error'), true, '应标成错误');
  assert.ok(notice.textContent.includes('超时'), `应把原因说清楚，实际：${notice.textContent}`);
});

maybe('主进程迟迟不返回时，界面自己超时并恢复（不靠主进程兜底）', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('rank');

  // 永远不 resolve：模拟 IPC 挂死。
  // 界面的 30 秒上限在这里用缩短版验证逻辑（直接调 withDeadline）。
  const pending = new Promise(() => {});
  const started = Date.now();
  let failed = null;
  try {
    await window.withDeadline(pending, 120, '抓取超时');
  } catch (err) {
    failed = err;
  }
  assert.ok(failed, '超时后必须 reject，不能无限等待');
  assert.ok(failed.message.includes('超时'), `错误信息应说明超时，实际：${failed.message}`);
  assert.ok(Date.now() - started < 2000, '应在设定的时限附近就返回');
});

maybe('榜单抓取成功时正常写入并提示', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('rank');

  // 造一份最小可解析的 HTML：一根榜单条目
  const html = `<html><body>
    <div class="rank-list"><ul>
      <li><a href="/book/123">测试作品</a><span>1.2万</span></li>
    </ul></div>
  </body></html>`;
  let written = null;
  window.api.rank = { fetch: () => Promise.resolve(html) };
  window.api.data.write = (name, value) => { written = { name, value }; return Promise.resolve(true); };

  doc.getElementById('btnRefreshRank')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.ok(await waitFor(() => doc.getElementById('btnRefreshRank').disabled === false),
    '无论成功失败按钮都要恢复');

  // 解析不出条目时会走「未解析到榜单条目」分支，同样算正常结束
  const notice = doc.getElementById('rankNotice');
  assert.equal(notice.hidden, false, '应该给出结果说明');
  assert.ok(notice.textContent.length > 0);
});

maybe('抓取 Promise 永不 settle 时，按钮也必须自己恢复（本次 bug 的真实形态）', async (t) => {
  // 上面那条只验证了「reject 会恢复」，但真实故障是**永不 settle**：
  // 主进程 net.fetch 没超时 → Promise 永久挂起 → finally 从不执行 → 按钮永久禁用。
  // 必须让 fetch 返回一个永远 pending 的 Promise，才能测出这层兜底有没有生效。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('rank');

  // 把界面侧的超时从 30 秒缩短到 150ms，避免测试真等半分钟
  const realDeadline = window.withDeadline;
  let usedShort = 0;
  window.withDeadline = (p, ms, msg) => { usedShort += 1; return realDeadline(p, 150, msg); };

  // 永不 resolve —— 模拟 net.fetch 挂死
  window.api.rank = { fetch: () => new Promise(() => {}) };

  doc.getElementById('btnRefreshRank')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.ok(await waitFor(() => doc.getElementById('btnRefreshRank').disabled === false, 3000),
    '即使 IPC 永不返回，按钮也必须恢复可用 —— 否则用户只能重启软件');
  assert.equal(usedShort, 1, '界面侧必须用 withDeadline 包住这次 IPC');
  assert.equal(doc.getElementById('btnRefreshRank').textContent, '刷新榜单');
  const notice = doc.getElementById('rankNotice');
  assert.equal(notice.classList.contains('is-error'), true);
  assert.ok(notice.textContent.includes('超时'), `应说明超时，实际：${notice.textContent}`);
});

maybe('固定项在界面上没有 × 按钮，但 ▲▼ 还在（能排序）', async (t) => {
  // 用户要求：概览 / 数据看板 / 抓取与同步 / 功能中心 / 设置 不显示删除按钮，
  // 但调整顺序仍旧生效。这条直接查 DOM，防止以后有人把 isLocked 用歪。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');
  clickAdjust(window);

  const FIXED = ['overview', 'books', 'sync', 'plugins', 'settings'];
  for (const view of FIXED) {
    const item = doc.querySelector(`#nav .nav-item[data-view="${view}"]`);
    assert.ok(item, `${view} 应有导航项`);
    assert.equal(item.querySelector('[data-nav-tool="remove"]'), null,
      `${view} 不该有删除按钮`);
    assert.ok(item.querySelector('[data-nav-tool="up"]'), `${view} 仍应有上移按钮`);
    assert.ok(item.querySelector('[data-nav-tool="down"]'), `${view} 仍应有下移按钮`);
  }

  // 可删项仍然有 ×
  for (const view of ['writer', 'rank', 'miaoyu']) {
    const item = doc.querySelector(`#nav .nav-item[data-view="${view}"]`);
    assert.ok(item.querySelector('[data-nav-tool="remove"]'), `${view} 应有删除按钮`);
  }
});

maybe('固定项能被上移，并且保存后顺序真的变了', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');
  clickAdjust(window);

  const before = visibleNavOrder(doc);
  const i = before.indexOf('books');
  assert.ok(i > 0, '数据看板前面应还有别的项，才测得出上移');

  doc.querySelector('#nav .nav-item[data-view="books"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const after = visibleNavOrder(doc);
  assert.equal(after.indexOf('books'), i - 1, '固定项也必须能上移');

  doc.getElementById('btnNavSave')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(window.Prefs.get('navOrder', []).indexOf('books'), i - 1,
    '保存后固定项的新位置要落盘');
});

maybe('点不到 × 的固定项，即使被程序化触发也不会消失', async (t) => {
  // 双保险：DOM 里没有按钮，但 nav-order 的 remove 也必须拒绝。
  // 万一以后 UI 又把它渲染出来，逻辑层仍然是安全的。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));

  const order = window.NavOrder.defaultOrder();
  for (const view of ['overview', 'books', 'sync', 'plugins', 'settings']) {
    const res = window.NavOrder.remove(order, view);
    assert.equal(res.removed, false, `${view} 不该被移除`);
    assert.ok(res.order.includes(view));
  }
});


/* ---------- 侧边栏：调整态必须有出口 ---------- */

/** 把五个按钮的可见/可用状态读出来 */
function navButtonState(doc) {
  const read = (id) => {
    const el = doc.getElementById(id);
    if (!el || el.hidden) return 'hidden';
    return el.disabled ? 'disabled' : 'ok';
  };
  return {
    adjust: read('btnNavAdjust'),
    save: read('btnNavSave'),
    discard: read('btnNavDiscard'),
    exit: read('btnNavExit'),
    reset: read('btnNavReset'),
  };
}

maybe('刚进调整态、什么都没改时，仍有可点的退出按钮', async (t) => {
  // 用户报的问题：点「调整侧边栏」进去以后不做任何调整，
  // 「保存排列」和「撤销修改」都是灰的（没有改动可存/可撤），
  // 「调整侧边栏」「恢复初始」在调整态下又是隐藏的 ——
  // 于是四个按钮三个不可点、一个不显示，只能关窗口。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  // 进入前
  assert.equal(navButtonState(doc).exit, 'hidden', '非调整态不该显示退出按钮');

  clickAdjust(window);
  const s = navButtonState(doc);
  assert.equal(s.save, 'disabled', '没改动时保存应为禁用（免得用户以为存了什么）');
  assert.equal(s.discard, 'disabled', '没改动时撤销应为禁用');
  assert.equal(s.exit, 'ok', '退出按钮必须可点，这是唯一的出口');

  // 关键断言：至少有一个可用按钮
  const clickable = ['adjust', 'save', 'discard', 'exit', 'reset'].filter((k) => s[k] === 'ok');
  assert.ok(clickable.length >= 1, '调整态下必须存在可点的按钮，否则用户被困住');
  assert.deepEqual(clickable, ['exit'], '此时唯一可用的是退出');
});

maybe('点退出调整后回到非调整态，▲▼× 收起且没有改动落盘', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  const savedBefore = JSON.stringify(window.Prefs.get('navOrder', null));

  clickAdjust(window);
  assert.equal(doc.querySelector('#nav').classList.contains('is-editing'), true);

  doc.getElementById('btnNavExit')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(doc.querySelector('#nav').classList.contains('is-editing'), false,
    '退出后侧边栏不该再显示 ▲▼×');
  assert.equal(navButtonState(doc).adjust, 'ok', '「调整侧边栏」应回来');
  assert.equal(navButtonState(doc).exit, 'hidden', '退出按钮自己也要收起');
  assert.equal(JSON.stringify(window.Prefs.get('navOrder', null)), savedBefore,
    '什么都没改就退出，不该写任何顺序');
  assert.ok(doc.getElementById('navCustomTag').textContent.includes('默认')
    || doc.getElementById('navCustomTag').textContent.includes('已自定义'),
  '标签应回到正常状态，不再是「调整中」');
});

maybe('改了一点再点退出：改动被丢弃，不写盘', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  const savedBefore = JSON.stringify(window.Prefs.get('navOrder', null));
  const orderBefore = visibleNavOrder(doc).join(',');

  clickAdjust(window);
  doc.querySelector('#nav .nav-item[data-view="rank"] [data-nav-tool="remove"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(visibleNavOrder(doc).includes('rank'), false, '预览里已经移除了');

  doc.getElementById('btnNavExit')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(visibleNavOrder(doc).join(','), orderBefore, '退出后顺序应还原');
  assert.ok(visibleNavOrder(doc).includes('rank'), '被移除的项要回来');
  assert.equal(JSON.stringify(window.Prefs.get('navOrder', null)), savedBefore,
    '退出不带保存，偏好里不能变');
});

maybe('调整态下三个按钮各司其职，不会互相顶掉', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;
  window.setActiveView('settings');

  clickAdjust(window);
  // 有改动后：保存与撤销都可用，退出依然可用
  doc.querySelector('#nav .nav-item[data-view="miaoyu"] [data-nav-tool="up"]')
    .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  const s = navButtonState(doc);
  assert.equal(s.save, 'ok', '有改动后保存应可用');
  assert.equal(s.discard, 'ok', '有改动后撤销应可用');
  assert.equal(s.exit, 'ok', '退出任何时候都可用');
  assert.equal(s.adjust, 'hidden', '调整态下不显示「调整侧边栏」');
  assert.equal(s.reset, 'hidden', '调整态下不显示「恢复初始」');
});

/* ---------- 密码本：「记住这次输入」必须给出看得见的反馈 ---------- */

maybe('点「记住这次输入」成功后，按钮自己变成「已保存 ✓」', async (t) => {
  // 用户反馈「点了没有反应」：原来唯一的反馈是工具条最右端一行 10px 灰字，
  // 点完按钮视线还在按钮上，根本不会往那边看。
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));

  const item = { id: 'v1', username: '13800001111', authorName: '', mode: 'account' };
  window.api.vault.capture = () => Promise.resolve({ item, items: [item] });

  const doc = window.document;
  const btn = doc.getElementById('btnVaultCapture');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await waitFor(() => btn.textContent.includes('已保存'));
  assert.ok(btn.textContent.includes('已保存'), `按钮应变成已保存，实际：${btn.textContent}`);
  assert.equal(btn.classList.contains('is-flash-ok'), true, '成功态要有自己的样式');

  const hint = doc.getElementById('vaultHint');
  await waitFor(() => hint.textContent.includes('已保存'));
  assert.ok(hint.textContent.includes('13800001111'), '提示条要说明存了哪个账号');
  assert.equal(hint.classList.contains('is-ok'), true);
});

maybe('保存失败时按钮明确说「没保存」，不做静默失败', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));

  window.api.vault.capture = () => Promise.reject(new Error('登录框里还没有内容'));

  const doc = window.document;
  const btn = doc.getElementById('btnVaultCapture');
  btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  await waitFor(() => btn.textContent.includes('没保存'));
  assert.equal(btn.classList.contains('is-flash-err'), true, '失败态要有自己的样式');
  const hint = doc.getElementById('vaultHint');
  assert.ok(hint.textContent.includes('登录框里还没有内容'), '真实原因要如实显示，不能吞掉');
});

maybe('提示文字变化会重算平台视图，新增的那一行不会被网页盖住', () => {
  // 平台页面是原生视图，位置按「量到的工具条高度」定。提示变长让工具条多一行，
  // 不重算就会把那一行压在网页下面——表现就是「点了没反应」。
  const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  const start = src.indexOf('function setVaultHint');
  assert.ok(start > 0, '应能找到 setVaultHint');
  // 只取函数体：从函数头到第一个行首的右花括号，
  // 否则下面紧挨着的 ResizeObserver 块里也有 syncBounds()，会把这条断言蒙过去
  const body = src.slice(start, src.indexOf('\n}', start));
  assert.ok(/syncBounds\(\)/.test(body), 'setVaultHint 里必须调用 syncBounds()');

  // 更稳的一层：盯工具条自身高度，展开说明 / 打开管理面板 / 按钮换行都能覆盖
  assert.ok(/ResizeObserver\([^)]*\)\s*\.observe\(vaultBarEl\)/.test(src)
    || /observe\(vaultBarEl\)/.test(src),
    '必须用 ResizeObserver 盯住 #vaultBar 的高度变化');
});

/* ---------- 摸鱼码字：第一次点按钮先讲清楚怎么用 ---------- */

maybe('摸鱼码字：第一次点按钮弹说明卡，之后不再弹', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  // 模拟「没看过说明」的冷启动
  window.Prefs.set('moyuGuideShown', false);
  doc.getElementById('guideDialog').hidden = true;

  assert.equal(window.maybeShowMoyuGuide(), true);
  assert.equal(doc.getElementById('guideDialog').hidden, false, '第一次点必须弹');
  assert.match(doc.getElementById('guideTitle').textContent, /摸鱼码字/);
  assert.ok(doc.querySelectorAll('#guideSteps li').length >= 3, '至少三条能照着做的步骤');
  assert.equal(doc.getElementById('guideSteps').innerHTML.includes('&lt;'), false,
    '步骤会被 escapeHtml 转义，夹 HTML 标签只会原样显示成尖括号');

  const primary = doc.querySelector('#guideActions .btn.primary');
  assert.equal(primary.textContent, '开始写');
  primary.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  assert.equal(doc.getElementById('guideDialog').hidden, true, '点「开始写」之后卡片要关掉');

  assert.equal(window.Prefs.get('moyuGuideShown', false), true, '看过要落盘，否则每次点都弹');
  assert.equal(window.maybeShowMoyuGuide(), false, '第二次不该再弹');
  assert.equal(doc.getElementById('guideDialog').hidden, true);
});

/* ---------- 码字台显示设置：字体从 4 种扩到 11 种 ---------- */

maybe('字体下拉：选项够多，选中后正文变量真的跟着换', async (t) => {
  const page = bootPage();
  t.after(() => page.dom.window.close());
  const { window } = page;
  assert.ok(await waitBoot(window));
  const doc = window.document;

  const sel = doc.getElementById('wdpFont');
  assert.ok(sel.options.length >= 10, `字体只有 ${sel.options.length} 项，用户已经嫌 4 项太少`);

  // 每一项都得真能落到 --writer-font 上，不能选了没反应
  const seen = new Set();
  for (const opt of Array.from(sel.options)) {
    sel.value = opt.value;
    sel.dispatchEvent(new window.Event('change'));
    const applied = doc.getElementById('writerWorkspace').style.getPropertyValue('--writer-font');
    assert.ok(applied && applied.trim(), `选「${opt.textContent}」之后 --writer-font 是空的`);
    assert.equal(seen.has(applied), false, `「${opt.textContent}」和别的字体用了同一串字体族`);
    seen.add(applied);
  }

  // 挑一项非默认的，确认写进了偏好（下次打开还是它）
  const target = 'fangsong';
  sel.value = target;
  sel.dispatchEvent(new window.Event('change'));
  assert.equal(window.Prefs.get('writerDisplay', {}).font, target, '换字体要落盘');
  assert.match(doc.getElementById('writerWorkspace').style.getPropertyValue('--writer-font'), /FangSong/);
});
