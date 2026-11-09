'use strict';

/**
 * 摸鱼浮层的观感约束。
 *
 * 用户反馈过三次，都是纯样式/观感问题、逻辑测试盯不住：
 *   1. 只有左上角一点点能拖（把手太矮太透明）；
 *   2. 那条深色工具条像贴了张纸条（要求整条透明，字跟正文同色，只有握把带点颜色）；
 *   3. 字体是不是跟着码字台走（要求跟随字体，字号行距仍各管各的）。
 *
 * 这里直接读 CSS / 接线代码守这几条，改过头会立刻变红。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normaliseFontStack } = require('../src/main/moyu-config');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function rule(css, selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start > -1, `overlay.css 里找不到 ${selector}`);
  return css.slice(start, css.indexOf('}', start));
}

test('把手整条透明：不铺底色、不挂阴影，字色跟正文同一个设置项', () => {
  const css = read('src/renderer/overlay.css');
  const block = rule(css, '.handle');

  assert.match(block, /background:\s*transparent/, '把手不能再铺底色');
  assert.doesNotMatch(block, /box-shadow/, '透明之后再挂阴影，会露出一条灰带');
  assert.match(block, /color:\s*var\(--ink\)/,
    '字色要跟着 --ink（正文字色的同一个设置项），不能写死白色');
  assert.match(block, /cursor:\s*move/, '拖动区光标要是十字箭头');
  assert.doesNotMatch(block, /-webkit-app-region:\s*drag/,
    '不能用系统拖拽区：页面收不到鼠标事件，光标也改不成十字箭头');
});

test('只有握把留颜色，按钮只留描边', () => {
  const css = read('src/renderer/overlay.css');

  const grip = rule(css, '.handle .grip');
  assert.match(grip, /background:\s*rgba\(/, '握把要留一点底色，否则找不到能拖的地方');
  assert.doesNotMatch(grip, /background:\s*transparent/, '握把是整条把手唯一该有颜色的地方');

  // 注意要按行首匹配：`.handle .hbtn {` 这种组合选择器里也含 `.hbtn {`
  const btnStart = css.search(/^\.hbtn \{/m);
  assert.ok(btnStart > -1, '找不到 .hbtn 规则');
  const btn = css.slice(btnStart, css.indexOf('}', btnStart));
  assert.match(btn, /background:\s*transparent/, '按钮不能有深色填充，否则浮出几个小方块');
  assert.match(btn, /color:\s*var\(--ink\)/, '按钮文字也要跟着正文颜色');
  assert.match(btn, /border:\s*1px solid currentColor/, '按钮只靠描边成形');
});

test('开了描边时，把手上的字也加暗影（不然浅色网页上白字看不清）', () => {
  const css = read('src/renderer/overlay.css');
  const start = css.indexOf('body.has-outline .handle');
  assert.ok(start > -1, '缺少 body.has-outline 下的把手规则');
  const block = css.slice(start, css.indexOf('}', start));
  assert.match(block, /text-shadow/, '把手文字没跟着加暗影');
  assert.match(block, /\.chapter/, '章节名要跟上');
  assert.match(block, /\.hbtn/, '按钮文字也要跟上');
});

/* ---------------------------------------------------- 字体：只跟随字体，不跟随字号 */

test('正文字体走 --font，不再写死微软雅黑', () => {
  const css = read('src/renderer/overlay.css');
  const start = css.indexOf('.editor {');
  const block = css.slice(start, css.indexOf('}', start));
  assert.ok(block.includes('font-family: var(--font)'),
    '正文必须用 var(--font)，写死字体族的话码字台换宋体/楷体浮层不会变');
  assert.ok(css.includes('--font:'), ':root 里要有 --font 兜底值');

  // 兜底值要跟码字台默认字体一致，否则「没传值」时又变成另一套排版
  const rootStart = css.indexOf(':root {');
  const rootBlock = css.slice(rootStart, css.indexOf('}', rootStart));
  assert.ok(rootBlock.includes('Microsoft YaHei'), '--font 的兜底应跟码字台默认（微软雅黑）一致');
});

test('打开浮层时把码字台的字体传下去，字号行距仍用浮层自己的', () => {
  const app = read('src/renderer/app.js');
  const openAt = app.indexOf('window.api.moyu.open({');
  assert.ok(openAt > -1, '找不到打开浮层的调用');
  const payload = app.slice(openAt, app.indexOf('});', openAt));
  assert.ok(payload.includes('font: WRITER_FONTS[writerDisplayPrefs().font]'),
    '要把码字台当前字体解析成 CSS 字体族一起传过去');
  assert.ok(payload.includes('fontSize') === false && payload.includes('lineHeight') === false,
    '字号/行距不能跟着传：浮层有自己的一套（更大更松），传了就把浮层的可读性拉低');

  const writer = read('src/main/moyu-writer.js');
  assert.ok(writer.includes('sessionFont = normaliseFontStack(data.font)'),
    '主进程要先归一化再存，别把原始字符串直接塞进 CSS 变量');
  assert.ok(writer.includes('font: sessionFont'), 'init 消息要带上字体');
  assert.ok(writer.includes('sessionFont = \'\''),
    '关浮层要把缓存的字体清掉，否则下次换字体前会沿用上一本的字');

  const overlay = read('src/renderer/overlay.js');
  assert.ok(overlay.includes('applyFont(payload.font)'), '浮层要在 init 时应用字体');
});

test('normaliseFontStack：留下字体名与逗号，剔掉能破坏样式的字符', () => {
  assert.equal(normaliseFontStack('  "Noto Serif SC", serif  '), '"Noto Serif SC", serif');
  assert.equal(normaliseFontStack('a;}b{<c>'), 'abc', '花括号/分号/尖括号会截断后面的样式');
  assert.equal(normaliseFontStack(''), '');
  assert.equal(normaliseFontStack(null), '');
  assert.equal(normaliseFontStack('x'.repeat(300)).length, 160, '要限长，配置文件可能被手改');
  // 楷体这类中文名不能被剥掉
  assert.equal(normaliseFontStack('KaiTi, 楷体, serif'), 'KaiTi, 楷体, serif');
});
