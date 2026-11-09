'use strict';

/**
 * 码字台字体清单的约束。
 *
 * 起因：字体下拉原来只有 4 项（雅黑 / 宋体 / 楷体 / 系统默认），用户觉得太少。
 * 扩到 11 项之后，最容易犯的错是「加了 option 忘了加字体族」或反过来——
 * 那样下拉里选得到、实际不生效，或者保存了却再也选不回来。
 *
 * app.js 是渲染进程脚本、不是模块，这里按源码文本守约束，跟
 * moyu-overlay-style.test.js 一个路数。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 从 WRITER_FONTS 里读出 { 键: 字体族 } */
function fontMap() {
  const app = read('src/renderer/app.js');
  const start = app.indexOf('const WRITER_FONTS = {');
  assert.ok(start > -1, 'app.js 里找不到 WRITER_FONTS');
  const block = app.slice(start, app.indexOf('};', start));
  const map = {};
  for (const m of block.matchAll(/^\s*([A-Za-z]\w*):\s*'([^']*)',?$/gm)) {
    map[m[1]] = m[2];
  }
  return map;
}

/** 从 #wdpFont 里读出选项顺序 */
function fontOptions() {
  const html = read('src/renderer/index.html');
  const start = html.indexOf('id="wdpFont"');
  assert.ok(start > -1, 'index.html 里找不到字体下拉 #wdpFont');
  const block = html.slice(start, html.indexOf('</select>', start));
  return [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
}

test('字体不再是 4 种：至少 10 项，且分了组', () => {
  const options = fontOptions();
  assert.ok(options.length >= 10, `只有 ${options.length} 项，用户已经嫌少了`);

  const html = read('src/renderer/index.html');
  const start = html.indexOf('id="wdpFont"');
  const block = html.slice(start, html.indexOf('</select>', start));
  const groups = [...block.matchAll(/<optgroup label="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(groups.length >= 3, '选项一多就该分组，否则找字体要先扫一遍');
});

test('下拉选项与 WRITER_FONTS 一一对应，不许有孤儿', () => {
  const map = fontMap();
  const options = fontOptions();

  assert.deepEqual([...options].sort(), Object.keys(map).sort(),
    '多一个 option 没字体族 = 选了不生效；多一个字体族没 option = 老用户的选择再也选不回来');
});

test('每个字体族都以通用族收尾，并且带一个中文字体兜底', () => {
  const CJK = [
    'Microsoft YaHei', 'PingFang SC', 'SimHei', 'Heiti SC', 'Noto Sans SC',
    'Source Han Sans SC', 'DengXian', 'SimSun', 'Songti SC', 'Noto Serif SC',
    'Source Han Serif SC', 'FangSong', 'STFangsong', 'KaiTi', 'Kaiti SC',
    'STKaiti', 'LXGW WenKai', 'YouYuan', 'Yuanti SC',
  ];

  for (const [key, stack] of Object.entries(fontMap())) {
    assert.match(stack, /(sans-serif|serif)$/,
      `${key} 没有通用族收尾，最后会退回浏览器默认字体`);
    assert.ok(CJK.some((name) => stack.includes(name)),
      `${key} 里没有一个中文字体，中文会掉到别的字体上渲染`);
  }
});

test('配置文件里存了不认识的字体名时，退回默认值而不是让下拉框空着', () => {
  const app = read('src/renderer/app.js');
  assert.ok(app.includes('if (!WRITER_FONTS[v.font]) v.font = WRITER_DISPLAY_DEFAULT.font;'),
    'writerDisplayPrefs 要校验字体键，手改配置或删字体后下拉框不能变空白');
});

test('字体面板给一句提示，说明思源/霞鹜需要系统里装了才生效', () => {
  const html = read('src/renderer/index.html');
  assert.match(html, /class="wdp-hint"/, '面板里要有一行字体说明');
  assert.match(html, /霞鹜/, '提示要提到需要自行安装的字体，免得用户以为是软件坏了');

  const css = read('src/renderer/style.css');
  assert.match(css, /\.wdp-hint \{/, '.wdp-hint 要有样式，否则是 14px 的正文里插一行大字');
});
