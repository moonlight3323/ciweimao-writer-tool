'use strict';

/**
 * 摸鱼码字（透明浮层）的测试。
 *
 * 分三层：
 *   1. 纯函数：设置归一化、快捷键降级链（主进程模块 require('electron')，
 *      所以逻辑抽在 moyu-config.js 里，这里直接 require）；
 *   2. 接线：清单声明、按钮显隐、IPC 通道、正文落地路径是否都接上了——
 *      这类「少一行就整块失效」的东西，只能靠读文件守住；
 *   3. 浮层页面：用 jsdom 真跑 overlay.js，验证「打字 → 回推」「Esc → 藏起来」
 *      「改字号 → 发设置」。界面观感测不了，但交互逻辑能测。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');
const { DEFAULTS, normaliseSettings, normaliseAccelerator, hotkeyCandidates, pickHotkey, HOTKEYS } =
  require('../src/main/moyu-config');

let JSDOM = null;
try {
  // eslint-disable-next-line global-require
  ({ JSDOM } = require('jsdom'));
} catch (_) {
  JSDOM = null;
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------ 纯函数：设置 */

test('设置归一化：空值给默认，脏值夹回区间，多余字段丢掉', () => {
  const d = normaliseSettings(undefined);
  assert.equal(d.fontSize, DEFAULTS.fontSize);
  assert.equal(d.textColor, DEFAULTS.textColor);
  assert.equal(d.x, null, '没摆过位置时 x/y 必须是 null，不能是 0（0 是左上角）');

  const dirty = normaliseSettings({
    fontSize: 999, // 上限 48
    lineHeight: 9,
    bgAlpha: -20,
    width: 10,
    height: 99999,
    textColor: 'red', // 不是 #RRGGBB
    outline: 'yes',
    x: 120.6,
    y: null,
    hotkey: 'x'.repeat(200),
    unknownKey: '应该被丢掉',
  });
  assert.equal(dirty.fontSize, 48);
  assert.equal(dirty.lineHeight, 2.6);
  assert.equal(dirty.bgAlpha, 0);
  assert.equal(dirty.width, 360);
  assert.equal(dirty.height, 900);
  assert.equal(dirty.textColor, DEFAULTS.textColor);
  assert.equal(dirty.outline, true);
  assert.equal(dirty.x, 121, '位置取整，避免拖完写出小数');
  assert.equal(dirty.y, null);
  assert.equal(dirty.hotkey, '', '不是合法 accelerator 的串必须清空，不能原样写进 globalShortcut');
  assert.equal(Object.prototype.hasOwnProperty.call(dirty, 'unknownKey'), false);
});

test('设置归一化：颜色缺 # 或长度不对都不能进 CSS', () => {
  assert.equal(normaliseSettings({ textColor: '#ffcc00' }).textColor, '#FFCC00');
  assert.equal(normaliseSettings({ bgColor: '#12345' }).bgColor, DEFAULTS.bgColor);
  assert.equal(normaliseSettings({ textColor: '#GGGGGG' }).textColor, DEFAULTS.textColor);
});

/* ------------------------------------------------------------ 纯函数：快捷键 */

test('快捷键降级链：跳过后面的组合，返回第一个能注册的', () => {
  const tried = [];
  const picked = pickHotkey(HOTKEYS, (combo) => {
    tried.push(combo);
    return combo === HOTKEYS[1];
  });
  assert.equal(picked, HOTKEYS[1]);
  assert.deepEqual(tried, [HOTKEYS[0], HOTKEYS[1]], '注册成功就该停下，不再往下试');
});

test('快捷键降级链：全被占用返回空串，抛异常也当失败', () => {
  assert.equal(pickHotkey(HOTKEYS, () => false), '');
  assert.equal(pickHotkey(HOTKEYS, () => { throw new Error('ERROR_HOTKEY_ALREADY_REGISTERED'); }), '');
  assert.equal(pickHotkey([], () => true), '');
  assert.equal(pickHotkey(null, () => true), '');
});

test('快捷键候选里没有裸 F 键（本机这类组合常被录屏工具占着）', () => {
  for (const combo of HOTKEYS) {
    assert.match(combo, /^CommandOrControl\+/, `${combo} 必须带修饰键`);
  }
});

test('自定义快捷键：写法归一，修饰键顺序固定', () => {
  assert.equal(normaliseAccelerator('ctrl+alt+m'), 'CommandOrControl+Alt+M');
  assert.equal(normaliseAccelerator('Shift+Ctrl+K'), 'CommandOrControl+Shift+K');
  assert.equal(normaliseAccelerator('win+alt+3'), 'Alt+Super+3');
  assert.equal(normaliseAccelerator('option+super+shift+f9'), 'Alt+Shift+Super+F9');
});

test('自定义快捷键：单键、无修饰、非法主键一律不收', () => {
  const bad = ['', 'M', 'Ctrl', 'Ctrl+Shift', 'Ctrl+Space', 'Ctrl+Escape', 'Ctrl+Tab',
    'Ctrl+F25', 'Ctrl+Alt+中', 'Hyper+M', 'Ctrl++M', 123, null];
  for (const value of bad) {
    assert.equal(normaliseAccelerator(value), '', `${String(value)} 不该被接受 —— 全局热键会吃掉整机这个键`);
  }
});

test('自定义排在内置链最前面，和内置重合时只注册一次', () => {
  assert.deepEqual(hotkeyCandidates(''), HOTKEYS, '没设自定义就走原链');
  assert.deepEqual(hotkeyCandidates('ctrl+alt+m'), HOTKEYS, '和默认第一条重合，不能重复注册');
  const list = hotkeyCandidates('Shift+Ctrl+K');
  assert.equal(list[0], 'CommandOrControl+Shift+K', '自定义必须排第一');
  assert.equal(new Set(list).size, list.length, '候选里不能有重复组合');
});

test('自定义的注册不上时，仍然靠内置链兜底', () => {
  const custom = 'CommandOrControl+Shift+K';
  const tried = [];
  const picked = pickHotkey(hotkeyCandidates(custom), (combo) => {
    tried.push(combo);
    return combo !== custom;      // 模拟自定义被别的软件占着
  });
  assert.equal(tried[0], custom, '先试用户设的那个');
  assert.equal(picked, HOTKEYS[0], '自定义失败后必须继续试内置组合，不能直接没有快捷键');
});

/* ------------------------------------------------------------ 清单与接线 */

test('内置清单：id 与目录名一致，声明了码字台按钮与读写权限', () => {
  const file = path.join(ROOT, 'bundled-plugins', 'moyu-writer', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(manifest.id, 'moyu-writer');
  assert.equal(path.basename(path.dirname(file)), manifest.id, '目录名必须等于 id');
  assert.ok(manifest.contributes && manifest.contributes.editorButton, '必须声明 editorButton');
  assert.equal(manifest.contributes.editorButton.label, '摸鱼码字');
  assert.deepEqual(manifest.permissions.slice().sort(), ['editor.read', 'editor.write']);
});

test('功能中心的清单会透传 editorButton', () => {
  const src = read('src/main/plugins.js');
  assert.ok(/editorButton:\s*manifest\.contributes/.test(src),
    'plugins.js 的 readManifest 必须归一化 contributes.editorButton，否则界面读不到');
});

test('码字台入口：默认隐藏，靠功能中心的开关点亮', () => {
  const html = read('src/renderer/index.html');
  const line = html.match(/<button[^>]*id="btnWriterMoyu"[^>]*>/);
  assert.ok(line, 'index.html 必须有 #btnWriterMoyu');
  assert.match(line[0], /hidden/, '默认必须 hidden —— 功能没开时不该出现');

  const app = read('src/renderer/app.js');
  assert.ok(app.includes("const MOYU_PLUGIN_ID = 'moyu-writer'"));
  assert.ok(/function syncMoyuEntry\(\)/.test(app));
  const inLoad = app.slice(app.indexOf('async function loadPlugins'), app.indexOf('async function refreshBuiltInIncomeEditorStat'));
  assert.ok(inLoad.includes('syncMoyuEntry()'),
    'loadPlugins 里必须调 syncMoyuEntry，否则开/关功能后按钮不跟着变');
});

test('正文落地：整段覆盖后必须走原有的保存链路', () => {
  const app = read('src/renderer/app.js');
  const fn = app.slice(app.indexOf('function applyMoyuText'), app.indexOf("$('#btnWriterMoyu').addEventListener"));
  for (const call of ['syncWriterChapterFromForm()', 'updateWriterWordCount()', 'markWriterDirty()', 'renderWriterStats()', 'scheduleBadwordScan()']) {
    assert.ok(fn.includes(call), `applyMoyuText 少了 ${call}，正文会写进去但统计/保存不跟着更新`);
  }
  // 打开时必须把当前正文递进去，否则浮层是空的、用户以为丢稿
  assert.ok(app.includes('content: writerContent.value'), '打开浮层必须带上当前正文');
  assert.ok(app.includes('await writerSaveNow(true)'), '打开前应先落一次盘');
});

test('主进程：透明置顶窗口 + IPC 通道齐全 + 退出归还热键', () => {
  const src = read('src/main/moyu-writer.js');
  for (const key of ['transparent: true', 'frame: false', 'skipTaskbar: true', "setAlwaysOnTop(true, 'screen-saver')"]) {
    assert.ok(src.includes(key), `浮层窗口缺少 ${key}`);
  }
  assert.ok(src.includes('globalShortcut.register'), '必须注册全局快捷键');
  assert.ok(src.includes('globalShortcut.unregister'), '结束会话必须归还快捷键');

  const main = read('src/main/main.js');
  assert.ok(main.includes("ipcMain.handle('moyu:open'"));
  assert.ok(main.includes("ipcMain.on('moyu:input'"));
  assert.ok(main.includes("ipcMain.on('moyu:restore'"));
  assert.ok(main.includes('moyuWriter.dispose()'), 'will-quit 里必须 dispose，否则热键会泄漏');
  assert.ok(main.includes('backgroundThrottling: false'),
    '主窗口被 hide 时不能节流：自动保存的 900ms 会被拖到 1s 以上');
  // 浮层被 Alt+F4 关掉时主窗口还藏着，必须兜底还回去，否则用户被锁在外面
  const closedHandler = src.slice(src.indexOf("overlay.on('closed'"), src.indexOf("overlay.on('closed'") + 420);
  assert.ok(closedHandler.includes('deps.onRestore'), "closed 兜底必须把主窗口还回去");

  const preload = read('src/preload/preload.js');
  assert.ok(preload.includes("invoke('moyu:open'"));
  assert.ok(preload.includes("ipcRenderer.on('moyu:text'"));
});

test('关闭会话时补读一次正文：输入是防抖的，点「回到软件」可能丢最后几个字', () => {
  const src = read('src/main/moyu-writer.js');
  const fn = src.slice(src.indexOf('async function closeSession'), src.indexOf('function applySettings'));
  assert.ok(fn.includes('readOverlayText'), 'closeSession 必须先读一次浮层里的正文');
  assert.ok(fn.includes('forwardText(text)'), '读到的正文要推回码字台');
});

/* ------------------------------------------------------------ 浮层页面（jsdom） */

function bootOverlay() {
  const html = fs.readFileSync(path.join(RENDERER, 'overlay.html'), 'utf8')
    .replace('<script src="overlay.js"></script>', '');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://overlay.local/overlay.html',
  });
  const calls = { input: [], hide: 0, restore: 0, settings: [], dragStart: 0, dragEnd: 0 };
  let initCb = null;
  dom.window.overlayApi = {
    onInit: (cb) => { initCb = cb; },
    onSettings: () => {},
    onHotkey: () => {},
    input: (text) => calls.input.push(text),
    hide: () => { calls.hide += 1; },
    restore: () => { calls.restore += 1; },
    settings: (patch) => calls.settings.push(patch),
    dragStart: () => { calls.dragStart += 1; },
    dragEnd: () => { calls.dragEnd += 1; },
  };
  dom.window.eval(fs.readFileSync(path.join(RENDERER, 'overlay.js'), 'utf8'));
  return { dom, calls, init: (payload) => initCb(payload) };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('浮层：初始化把章节正文铺进编辑区并算好字数', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, init } = bootOverlay();
  init({
    text: '第一段\n第二段 还有空格',
    title: '第十二章',
    bookName: '测试书',
    settings: { fontSize: 24, textColor: '#FFD166', bgAlpha: 20 },
    hotkey: 'CommandOrControl+Alt+M',
  });
  const doc = dom.window.document;
  assert.equal(doc.getElementById('editor').value, '第一段\n第二段 还有空格');
  assert.equal(doc.getElementById('chapterName').textContent, '第十二章');
  // 字数口径与码字台一致：去掉空白后数长度
  assert.equal(doc.getElementById('countText').textContent, '10 字');
  assert.equal(doc.documentElement.style.getPropertyValue('--fs'), '24px');
  assert.match(doc.getElementById('hotkeyTip').textContent, /Ctrl\+Alt\+M/);
  dom.window.close();
});

test('浮层：打字按 120ms 防抖回推，不是每键一次', { skip: !JSDOM && '没装 jsdom' }, async () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '', settings: {}, hotkey: '' });
  const doc = dom.window.document;
  const editor = doc.getElementById('editor');
  editor.value = '一';
  editor.dispatchEvent(new dom.window.Event('input'));
  editor.value = '一二';
  editor.dispatchEvent(new dom.window.Event('input'));
  editor.value = '一二三';
  editor.dispatchEvent(new dom.window.Event('input'));
  assert.equal(calls.input.length, 0, '防抖期内不该推');
  await wait(180);
  assert.deepEqual(calls.input, ['一二三'], '只推最后一份完整文本');
  dom.window.close();
});

test('浮层：Esc 藏起来、把手上的「回到软件」关掉浮层', { skip: !JSDOM && '没装 jsdom' }, async () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '正文', settings: {}, hotkey: '' });
  const doc = dom.window.document;

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(calls.hide, 1, 'Esc 只藏浮层，不关会话');

  doc.getElementById('btnRestore').click();
  assert.equal(calls.restore, 1);
  await wait(160);
  assert.equal(calls.input[calls.input.length - 1], '正文', '关之前要先把正文推过去');
  dom.window.close();
});

test('浮层：改字号/字色会把设置发给主进程持久化', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '', settings: { fontSize: 20, textColor: '#FFFFFF' }, hotkey: '' });
  const doc = dom.window.document;

  // 面板对象来自 jsdom 那个 realm，deepStrictEqual 会栽在原型不同上，逐字段比
  doc.getElementById('fsUp').click();
  assert.equal(calls.settings[0].fontSize, 21);

  doc.getElementById('fsDown').click();
  assert.equal(calls.settings[1].fontSize, 20);

  doc.querySelector('.sw[data-color="#1F1D24"]').click();
  assert.equal(calls.settings[2].textColor, '#1F1D24');

  doc.getElementById('bgAlpha').value = '20';
  doc.getElementById('bgAlpha').dispatchEvent(new dom.window.Event('change'));
  assert.equal(calls.settings[3].bgAlpha, 20);
  dom.window.close();
});

/* ------------------------------------------------------------ 藏起来的两种手势 */

test('浮层：左键+右键同时按下会藏起来，并先把正文推过去', { skip: !JSDOM && '没装 jsdom' }, async () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '正文', settings: {}, hotkey: 'CommandOrControl+Alt+M' });
  const doc = dom.window.document;

  // buttons 是按位或：左 1 + 右 2 = 3
  doc.getElementById('editor').dispatchEvent(new dom.window.MouseEvent('mousedown', {
    buttons: 3, bubbles: true, cancelable: true,
  }));
  assert.equal(calls.hide, 1, '双键必须把浮层藏起来');
  await wait(160);
  assert.equal(calls.input[calls.input.length - 1], '正文', '藏之前要先把正文推过去');
  dom.window.close();
});

test('浮层：只按左键或只按右键不会藏起来（不然选字、右键都写不了）', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '正文', settings: {}, hotkey: '' });
  const doc = dom.window.document;
  const editor = doc.getElementById('editor');

  editor.dispatchEvent(new dom.window.MouseEvent('mousedown', { buttons: 1, bubbles: true }));
  editor.dispatchEvent(new dom.window.MouseEvent('mousedown', { buttons: 2, bubbles: true }));
  editor.dispatchEvent(new dom.window.MouseEvent('mousedown', { buttons: 0, bubbles: true }));
  assert.equal(calls.hide, 0);
  dom.window.close();
});

test('浮层：点快捷键格后按下组合，组合会发给主进程', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '', settings: {}, hotkey: 'CommandOrControl+Alt+M' });
  const doc = dom.window.document;
  const btn = doc.getElementById('btnHotkey');
  assert.equal(btn.textContent, 'Ctrl+Alt+M', '面板上写给人看的简写');

  btn.click();
  assert.equal(btn.textContent, '按下组合…', '点了就要明确进入捕获态，否则用户不知道要按键');

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
  }));
  const patches = calls.settings.filter((p) => Object.prototype.hasOwnProperty.call(p, 'hotkey'));
  assert.equal(patches.length, 1);
  assert.equal(patches[0].hotkey, 'CommandOrControl+Shift+K');
  assert.equal(btn.textContent, 'Ctrl+Alt+M', '等主进程回推前先显示原值，不能停在捕获态');
  dom.window.close();
});

test('浮层：捕获态按 Esc 只退出捕获，不能顺手把浮层藏了', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '', settings: {}, hotkey: 'CommandOrControl+Alt+M' });
  const doc = dom.window.document;
  doc.getElementById('btnHotkey').click();

  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(calls.hide, 0, 'Esc 在捕获态只是取消');
  assert.equal(calls.settings.some((p) => 'hotkey' in p), false, '取消不该发设置');
  assert.equal(doc.getElementById('btnHotkey').textContent, 'Ctrl+Alt+M');

  // 退出捕获后再按 Esc 才恢复「藏起来」
  doc.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', bubbles: true, cancelable: true,
  }));
  assert.equal(calls.hide, 1);
  dom.window.close();
});

test('浮层：主进程说自定义被占用时，面板要标出来用的是哪个', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, init } = bootOverlay();
  init({
    text: '',
    settings: { hotkey: 'CommandOrControl+Shift+K' },
    hotkey: 'CommandOrControl+Alt+M',
  });
  const doc = dom.window.document;
  const btn = doc.getElementById('btnHotkey');
  assert.equal(btn.classList.contains('is-warn'), true);
  assert.match(btn.textContent, /Ctrl\+Shift\+K/);
  assert.match(btn.textContent, /Ctrl\+Alt\+M/);
  assert.match(doc.getElementById('hotkeyTip').textContent, /被别的软件占着/);
  dom.window.close();
});

test('自定义快捷键要在主进程真的重注册，不能只存进配置', () => {
  const src = read('src/main/moyu-writer.js');
  const register = src.slice(src.indexOf('function registerHotkey'), src.indexOf('/** 快捷键：浮层显示中就藏起来'));
  assert.ok(register.includes('hotkeyCandidates(settings.hotkey)'),
    '注册时要带上用户设的组合，不能还硬编码内置链');

  const apply = src.slice(src.indexOf('function applySettings'), src.indexOf('function state'));
  assert.ok(apply.includes("hasOwnProperty.call(patch, 'hotkey')"), '要能分辨这次改动是不是快捷键');
  assert.ok(apply.includes('registerHotkey()'), '改完快捷键必须立刻重注册，否则用户还按着旧键');
});

test('把手够大够明显（用户反馈过只有左上角一点点能拖）', () => {
  const css = read('src/renderer/overlay.css');
  const start = css.indexOf('.handle {');
  const block = css.slice(start, css.indexOf('}', start));
  const height = Number((/height:\s*(\d+)px/.exec(block) || [])[1]);
  assert.ok(height >= 32, `把手高度只有 ${height}px，拖动区又会变成「一点点」`);

  const gripStart = css.indexOf('.handle .grip {');
  const grip = css.slice(gripStart, css.indexOf('}', gripStart));
  assert.ok(/width:\s*(\d+)px/.test(grip), '握把要有明确宽度，不能只是一个字符');
  assert.ok(/background:/.test(grip), '握把要有底色，否则看不出那里能拖');
});

test('码字台按钮：先判断是不是第一次，再进浮层', () => {
  const app = read('src/renderer/app.js');
  const start = app.indexOf("$('#btnWriterMoyu').addEventListener");
  const handler = app.slice(start, app.indexOf('window.api.moyu.onText'));
  assert.ok(start > 0 && handler.length > 0, '找不到按钮的点击处理');
  const guideAt = handler.indexOf('maybeShowMoyuGuide()');
  const openAt = handler.indexOf('openMoyuOverlay()');
  assert.ok(guideAt > -1, '第一次点按钮必须先弹说明卡，否则用户不知道窗口为什么消失');
  assert.ok(openAt > -1, '看过说明后要能进浮层');
  assert.ok(guideAt < openAt, '顺序不能反：先说明，再打开浮层');
});

/* ------------------------------------------------------------ 拖动把手 */

test('把手用十字箭头，且不再交给系统拖拽区', () => {
  const css = read('src/renderer/overlay.css');
  const start = css.indexOf('.handle {');
  const block = css.slice(start, css.indexOf('}', start));

  assert.ok(/cursor:\s*move/.test(block), '把手要显示十字箭头（cursor: move）');
  assert.equal(/-webkit-app-region:\s*drag/.test(block), false,
    '不能用 -webkit-app-region: drag：系统会吃掉鼠标事件，页面收不到指针，光标也改不成十字箭头');
  assert.equal(/cursor:\s*grabbing/.test(css), false, '别再用抓手指针，用户要的是十字箭头');

  const gripStart = css.indexOf('.handle .grip {');
  const grip = css.slice(gripStart, css.indexOf('}', gripStart));
  assert.ok(/cursor:\s*move/.test(grip), '握把也要是十字箭头');
});

test('拖动由自己实现：按下开始跟光标，松开停', () => {
  const src = read('src/main/moyu-writer.js');
  const fn = src.slice(src.indexOf('function startDrag'), src.indexOf('function ensureWindow'));
  assert.ok(fn.includes('screen.getCursorScreenPoint'), '要按系统光标的位置算位移，不能靠渲染层事件');
  assert.ok(fn.includes('setInterval'), '要持续跟着光标走');
  assert.ok(fn.includes('setPosition'), '窗口得真的挪');
  assert.ok(fn.includes('dragOrigin.window.x + (cur.x - dragOrigin.cursor.x)'),
    '位移 = 光标走了多少，窗口就走多少');

  assert.ok(src.includes('endDrag'), '必须能停下来');
  assert.ok(src.slice(src.indexOf('async function closeSession'), src.indexOf('function applySettings'))
    .includes('endDrag()'), '关浮层要停掉拖动，否则定时器还拴着窗口');

  const preload = read('src/preload/moyu-preload.js');
  assert.ok(preload.includes('dragStart') && preload.includes('dragEnd'));

  const main = read('src/main/main.js');
  assert.ok(main.includes("ipcMain.on('moyu:drag-start'"), '渲染层报的开始拖动要接到主进程');
  assert.ok(main.includes("ipcMain.on('moyu:drag-end'"));
});

test('浮层：按住把手开始拖，松开停；按在按钮上不拖', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '', settings: {}, hotkey: '' });
  const doc = dom.window.document;
  const handle = doc.getElementById('handle');

  handle.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  assert.equal(calls.dragStart, 1, '按在把手上要通知主进程开始拖');
  assert.equal(handle.classList.contains('is-dragging'), true, '拖动时把手要常亮');

  // 按在章节名这种文字上也算拖（整条把手都是拖动区）
  doc.dispatchEvent(new dom.window.MouseEvent('mouseup', { button: 0, bubbles: true }));
  assert.equal(calls.dragEnd, 1);
  assert.equal(handle.classList.contains('is-dragging'), false);

  doc.getElementById('chapterName').dispatchEvent(
    new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  assert.equal(calls.dragStart, 2, '把手上的文字区也要能拖');

  // 按在「回到软件」这类按钮上是点按钮，不能顺手把窗口拖走
  doc.getElementById('btnRestore').dispatchEvent(
    new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  assert.equal(calls.dragStart, 2, '按钮上按下不能启动拖动');

  // 右键按下也不该拖
  handle.dispatchEvent(new dom.window.MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
  assert.equal(calls.dragStart, 2);
  dom.window.close();
});

test('浮层：拖到一半被藏起来，要先把拖动停掉', { skip: !JSDOM && '没装 jsdom' }, () => {
  const { dom, calls, init } = bootOverlay();
  init({ text: '', settings: {}, hotkey: '' });
  const doc = dom.window.document;

  doc.getElementById('handle').dispatchEvent(
    new dom.window.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
  assert.equal(calls.dragStart, 1);

  doc.getElementById('btnHide').click();
  assert.equal(calls.hide, 1);
  assert.equal(calls.dragEnd, 1, '藏起来之前必须停掉拖动，否则窗口还黏着光标');
  dom.window.close();
});
