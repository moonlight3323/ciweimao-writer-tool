'use strict';

/**
 * 界面元素绑定的一致性检查
 *
 * 这个测试防的是一类很隐蔽的事故：app.js 里写了 `$('#btnXxx').addEventListener(...)`，
 * 而 index.html 里没有 id=btnXxx —— 脚本在这一行直接抛 null，**后面所有绑定都不再执行**，
 * 表现是「有些按钮点了没反应」，而且控制台里只有一条错。
 *
 * 之前界面测试（test:ui）就吃过这个亏：wordlib-ui.js 绑了手动加词的两个元素，
 * fixture 里没有，27 项一条都没跑到。所以这里对真实的 index.html 做一次全量核对。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

/** index.html 里出现过的所有 id */
function htmlIds() {
  const set = new Set();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) set.add(m[1]);
  return set;
}

/**
 * app.js 里通过 $('#xxx') 直接查的元素。
 * 只取字面量写法；模板字符串拼出来的（如 `#${id}`）这里识别不了，跳过即可。
 */
function appSelectors() {
  const out = new Set();
  const re = /\$\('#([A-Za-z][\w-]*)'\)/g;
  let m;
  while ((m = re.exec(APP)) !== null) out.add(m[1]);
  return out;
}

test('index.html 里没有重复 id', () => {
  const seen = new Map();
  const re = /\bid="([^"]+)"/g;
  let m;
  while ((m = re.exec(HTML)) !== null) {
    seen.set(m[1], (seen.get(m[1]) || 0) + 1);
  }
  const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  assert.deepEqual(dup, [], `重复 id 会导致 querySelector 只拿到第一个：${dup.join('、')}`);
});

test('app.js 里绑定到的每个 id 都在页面里存在', () => {
  const ids = htmlIds();
  const missing = [...appSelectors()].filter((id) => !ids.has(id)).sort();
  assert.deepEqual(missing, [],
    `这些 id 在 app.js 里用到但 index.html 里没有，脚本会在绑定处抛错：${missing.join('、')}`);
});

test('新版本的关键界面元素齐全', () => {
  const ids = htmlIds();
  const must = [
    // 数据管理
    'panelDataManage', 'btnDataReset', 'btnBackupNow', 'dataBackupList', 'dataBackupRoot',
    // 侧边栏自定义
    'panelNav', 'btnNavReset', 'navCustomHint', 'navCustomTag',
    'btnNavAdjust', 'btnNavSave', 'btnNavDiscard', 'btnNavExit', 'navFlash',
    // 道具获得（数据看板的下半部分，不再是独立页面）
    'boardBooks', 'btnBoardBack', 'propsSection', 'propsGrid', 'btnPropsRefresh', 'propsNote', 'propsRaw',
    'propsNotice', 'propsScanTag', 'propsNoteText', 'propsBook', 'propsBookHint',
    'propsGrain', 'propsChartCanvas', 'propsLegend', 'propsDetailBody', 'propsEmptyInline',
    'propsSettle', 'propsScanDetailTag', 'propsChartSub',
    // 密码本作者名 + 多选
    'vaultManage', 'vaultManageList', 'btnVaultManage', 'btnVaultBind',
    'btnVaultSelectAll', 'btnVaultSelectNone', 'btnVaultDeletePicked', 'btnVaultManageClose',
    // 功能中心
    'pluginGrid', 'pluginEmpty',
  ];
  const missing = must.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `缺少关键元素：${missing.join('、')}`);
});

test('密码本旧的单条删除按钮已移除', () => {
  const ids = htmlIds();
  assert.equal(ids.has('btnVaultDelete'), false,
    '单条删除已并入多选管理，旧按钮应当删掉，否则 app.js 绑定会抛错');
});

test('侧边栏与页面视图双向对齐', () => {
  const navViews = [];
  const navRe = /<button class="nav-item[^"]*" data-view="([^"]+)"/g;
  let m;
  while ((m = navRe.exec(HTML)) !== null) navViews.push(m[1]);

  const sections = new Set();
  const secRe = /<section[^>]*class="view[^"]*"[^>]*data-view="([^"]+)"/g;
  while ((m = secRe.exec(HTML)) !== null) sections.add(m[1]);

  for (const v of navViews) {
    assert.ok(sections.has(v), `侧边栏有 ${v}，但页面里没有对应视图`);
  }
  for (const v of sections) {
    assert.ok(navViews.includes(v), `页面里有视图 ${v}，但侧边栏没有入口`);
  }
});

test('渲染层脚本不能在顶层声明 api（会撞上 preload 的 window.api）', () => {
  // window.api 是 contextBridge 挂的不可配置属性。classic script 里写 `const api = …`
  // 会直接 SyntaxError "Identifier 'api' has already been declared"，**整个文件不执行**。
  // book-priority.js 就是这么静默失效的：window.BookPriority 一直是 undefined，
  // app.js 悄悄走了自己的兜底分支，两边规则随时可能分叉。
  const dir = path.join(ROOT, 'src', 'renderer');
  const offenders = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const hit = /^(?:const|let|var)\s+api\s*=/m.exec(src);
    if (!hit) continue;
    // 整个文件被 IIFE 包起来时（nav-order.js 那样），这个 const 是函数作用域，撞不到全局
    const iife = src.search(/^\(function/m);
    if (iife >= 0 && iife < hit.index) continue;
    offenders.push(file);
  }
  assert.deepEqual(offenders, [],
    `${offenders.join('、')} 在顶层声明了 api，换一个变量名（如 bookPriorityApi）`);
});
