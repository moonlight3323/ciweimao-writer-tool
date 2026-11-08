'use strict';

/**
 * 内置功能（bundled plugins）的安装/自愈
 *
 * 这条测试盯的是一个把用户逼进死角的事故：
 *
 *   清完数据 / 从旧备份恢复之后，功能中心是空的，顶部弹
 *   `打开插件失败：Error invoking remote method 'plugins:get': Error: 缺少有效的 manifest.json`
 *
 * 根因在 installBundled 的判据：
 *     if (registry[id] !== manifest.version) { 复制 }
 * 它**只比版本号**。数据目录被清空时 `data/bundled-plugins.json` 可能跟着旧备份
 * 一起回来了，登记表记着「这些装过」，而 `data/plugins/` 实际是空的 ——
 * 版本号相同 → 永远不再复制 → 内置功能再也回不来。
 * 更糟的是内置功能**没有重装入口**（只能停用不能删除，反过来说也删不掉重装不了）。
 *
 * 现在的判据是「版本不符 **或** 目标目录读不出有效 manifest」就装，
 * 并且主进程暴露了 plugins:repair，让「重新加载」能自己修回来。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const plugins = require('../src/main/plugins');

const ROOT = path.join(__dirname, '..');
const BUNDLED_ROOT = path.join(ROOT, 'bundled-plugins');

const MANIFEST = {
  id: 'demo-feature',
  name: '演示功能',
  version: '1.2.0',
  author: 'test',
  description: '仅用于测试',
  contributes: {},
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ciweimao-bundled-'));
}

/** 造一个内置插件源目录 */
function makeBundled(root, manifest) {
  const dir = path.join(root, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  fs.writeFileSync(path.join(dir, 'page.html'), '<!doctype html><p>ok</p>', 'utf8');
  return dir;
}

test('登记表说装过、磁盘上却没有 → 必须重装', () => {
  // 这就是用户遇到的状态：bundled-plugins.json 还在，plugins 目录是空的
  const root = tmp();
  try {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(path.join(dataDir, 'plugins'), { recursive: true });
    makeBundled(path.join(root, 'bundled'), MANIFEST);
    // 关键：登记表和内置版本完全一致
    fs.writeFileSync(
      path.join(dataDir, 'bundled-plugins.json'),
      JSON.stringify({ 'demo-feature': MANIFEST.version }),
      'utf8',
    );

    const installed = plugins.installBundled(dataDir, path.join(root, 'bundled'));
    assert.deepEqual(installed, ['demo-feature'],
      '登记表版本相同但目录不存在时，仍必须重新安装');

    const target = path.join(dataDir, 'plugins', 'demo-feature');
    assert.ok(fs.existsSync(path.join(target, 'manifest.json')), 'manifest.json 应被写回');
    assert.ok(fs.existsSync(path.join(target, 'page.html')), '页面文件应被写回');

    // 装完之后再跑一次不该重复安装
    assert.deepEqual(plugins.installBundled(dataDir, path.join(root, 'bundled')), [],
      '已经装好的不该每次启动都重装');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('目录在但 manifest 损坏 → 也要重装', () => {
  const root = tmp();
  try {
    const dataDir = path.join(root, 'data');
    const target = path.join(dataDir, 'plugins', 'demo-feature');
    fs.mkdirSync(target, { recursive: true });
    // 残缺文件：JSON 语法错
    fs.writeFileSync(path.join(target, 'manifest.json'), '{"id": "demo-feat', 'utf8');
    makeBundled(path.join(root, 'bundled'), MANIFEST);
    fs.writeFileSync(
      path.join(dataDir, 'bundled-plugins.json'),
      JSON.stringify({ 'demo-feature': MANIFEST.version }),
      'utf8',
    );

    const installed = plugins.installBundled(dataDir, path.join(root, 'bundled'));
    assert.deepEqual(installed, ['demo-feature'], 'manifest 读不出来就必须重装');
    const written = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    assert.equal(written.version, MANIFEST.version, '写回的应是内置版本');
    assert.equal(fs.existsSync(path.join(target, 'page.html')), true,
      '重装要先清空旧目录，不能残留残缺文件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('内置版本升级 → 覆盖安装', () => {
  const root = tmp();
  try {
    const dataDir = path.join(root, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    makeBundled(path.join(root, 'bundled'), MANIFEST);
    fs.writeFileSync(
      path.join(dataDir, 'bundled-plugins.json'),
      JSON.stringify({ 'demo-feature': '1.0.0' }),
      'utf8',
    );
    // 旧版本已经装在磁盘上
    const target = path.join(dataDir, 'plugins', 'demo-feature');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'manifest.json'),
      JSON.stringify({ ...MANIFEST, version: '1.0.0' }), 'utf8');

    assert.deepEqual(plugins.installBundled(dataDir, path.join(root, 'bundled')), ['demo-feature']);
    const now = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    assert.equal(now.version, '1.2.0', '应升到内置版本');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('needsBundledInstall 的四种情形', () => {
  const root = tmp();
  try {
    const target = path.join(root, 'demo-feature');
    const manifest = { id: 'demo-feature', version: '1.2.0' };

    // 1) 登记表里没有
    assert.equal(plugins.needsBundledInstall(target, manifest, {}), true);
    // 2) 版本不同
    assert.equal(plugins.needsBundledInstall(target, manifest, { 'demo-feature': '1.0.0' }), true);
    // 3) 版本相同但目录不存在
    assert.equal(plugins.needsBundledInstall(target, manifest, { 'demo-feature': '1.2.0' }), true);

    // 4) 版本相同且装好了 → 不装
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'manifest.json'),
      JSON.stringify({ id: 'demo-feature', name: 'x', version: '1.2.0' }), 'utf8');
    assert.equal(plugins.needsBundledInstall(target, manifest, { 'demo-feature': '1.2.0' }), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('真实内置插件都能通过校验，且 id 就是目录名', () => {
  // 防止打包漏文件：bundled-plugins 下每个目录都必须有可解析的 manifest.json
  const dirs = fs.readdirSync(BUNDLED_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory());
  assert.ok(dirs.length >= 2, '内置功能至少应有健康小助手与稿费计算器');
  for (const dir of dirs) {
    const file = path.join(BUNDLED_ROOT, dir.name, 'manifest.json');
    assert.ok(fs.existsSync(file), `${dir.name} 缺少 manifest.json`);
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(manifest.id, dir.name, `${dir.name} 的 manifest.id 必须与目录名一致`);
    assert.ok(manifest.version, `${dir.name} 缺少 version`);
  }
});

test('主进程暴露了 plugins:repair，「重新加载」才能自愈', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert.ok(main.includes("ipcMain.handle('plugins:repair'"),
    '必须有 plugins:repair：内置功能没有别的重装入口');
  const preload = fs.readFileSync(path.join(ROOT, 'src', 'preload', 'preload.js'), 'utf8');
  assert.ok(preload.includes('repair: () => ipcRenderer.invoke(\'plugins:repair\')'),
    'preload 必须转发 repair，否则界面调不到');

  const app = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const btn = app.slice(app.indexOf("$('#btnPluginReload')"));
  assert.ok(btn.slice(0, 900).includes('repair'),
    '「重新加载」按钮必须先补装内置功能');
});

/* ---------- 健康小助手的界面：配色与分组 ---------- */

const HH = path.join(BUNDLED_ROOT, 'health-helper');
const POMO = path.join(BUNDLED_ROOT, 'pomodoro');

test('两个插件都不出现纯黑底 / 纯黑遮罩（要和主界面同一套美术）', () => {
  // 用户反馈：悬浮球是黑底，设置面板外面一大圈黑色半透明，跟奶油色主界面格格不入。
  // 球的黑来自 `.ring-bg { fill: var(--surface) }` —— SVG 的 fill 默认就是纯黑，
  // 变量一旦没生效（主题未注入 / 样式被裁）就变成一块黑饼。
  for (const dir of [HH, POMO]) {
    const name = path.basename(dir);
    const css = fs.readFileSync(path.join(dir, 'style.css'), 'utf8');

    const ringBg = (css.match(/\.ring-bg\s*\{[^}]*\}/) || [''])[0];
    if (ringBg) {
      assert.equal(/fill:\s*var\(/.test(ringBg), false,
        `${name}: .ring-bg 的填充必须写死颜色 —— 用 var() 时一旦变量缺失会回退成纯黑`);
    }

    // 遮罩不能是 rgba(0,0,0,x) 这种黑色半透明
    const sheet = (css.match(/\.sheet\s*\{[^}]*\}/) || [''])[0];
    assert.ok(sheet, `${name}: 应有 .sheet 规则`);
    assert.equal(/rgba\(\s*0\s*,\s*0\s*,\s*0/.test(sheet), false,
      `${name}: 设置面板遮罩不能用纯黑半透明`);
    assert.ok(/rgba\(\s*24[0-9]/.test(sheet) || /rgba\(\s*20\s*,\s*20/.test(sheet),
      `${name}: 遮罩应是暖色（浅色主题）或深灰（深色主题），不是纯黑`);

    // 关键容器都要有兜底色，避免变量失效时透明
    for (const sel of ['.popover', '.sheet-card']) {
      const rule = (css.match(new RegExp(`\\${sel}\\s*\\{[^}]*\\}`)) || [''])[0];
      if (!rule) continue;
      assert.ok(/var\(--surface[^)]*,\s*#/.test(rule),
        `${name}: ${sel} 的 background 应带兜底色（var(--surface, #…)）`);
    }
  }
});

test('番茄钟是独立插件，健康提醒只留喝水与睡觉', () => {
  // 用户要求：番茄钟要「做成单独一个可以开关的功能」，不是设置面板里的分组。
  // 判据（全部从磁盘读，不靠记忆）：
  //   1. pomodoro 有完整的一套文件，manifest 声明 floatingWidget
  //   2. health-helper 里不再有番茄钟的痕迹（工作/休息/轮次/节奏预设）
  //   3. health-helper 不再声明 floatingWidget（球归番茄钟独占）
  const need = ['manifest.json', 'page.html', 'main.js', 'background.js', 'style.css'];
  for (const f of need) {
    assert.ok(fs.existsSync(path.join(POMO, f)), `pomodoro 缺少 ${f}`);
  }

  const pomoManifest = JSON.parse(fs.readFileSync(path.join(POMO, 'manifest.json'), 'utf8'));
  assert.equal(pomoManifest.id, 'pomodoro');
  assert.ok(pomoManifest.contributes.floatingWidget, '番茄钟应提供悬浮球');
  assert.ok(pomoManifest.contributes.editorStat, '番茄钟应在编辑区显示指标');

  const hhManifest = JSON.parse(fs.readFileSync(path.join(HH, 'manifest.json'), 'utf8'));
  assert.equal(hhManifest.contributes.floatingWidget, undefined,
    '健康提醒不该再挂悬浮球（会与番茄钟的球叠在一起）');
  assert.ok(hhManifest.description.includes('喝水'), '描述应说明自己管喝水');
  assert.ok(hhManifest.description.includes('睡觉'), '描述应说明自己管睡觉');
  // 描述里可以「指向」番茄钟（引导用户去哪找），但不能把这些当成自己的功能
  for (const word of ['专注计时', '工作 / 休息', '轮次', '节奏预设']) {
    if (word === '专注计时') continue; // 「专注计时请用番茄钟」是合法引导
    assert.equal(hhManifest.description.includes(word), false,
      `健康提醒的描述不该声称自己提供「${word}」`);
  }

  // 健康提醒的逻辑与页面里也不能再有番茄钟的东西。
  // 用「真实用法」判断而不是裸词包含：注释里提到旧字段名（说明它们搬去哪了）是允许的，
  // 那是给人看的线索，不该被判成残留代码。
  const hhJs = fs.readFileSync(path.join(HH, 'main.js'), 'utf8');
  const forbiddenInJs = [
    /\$\('#inWork'\)/, /\$\('#inRest'\)/, /\$\('#inRounds'\)/,
    /S\.presets/, /S\.timer/, /S\.pausedRemain/, /S\.rounds/,
  ];
  for (const re of forbiddenInJs) {
    assert.equal(re.test(hhJs), false, `健康提醒的 main.js 不该再操作 ${re}`);
  }
  const hhHtml = fs.readFileSync(path.join(HH, 'page.html'), 'utf8');
  for (const id of ['inWork', 'inRest', 'inRounds', 'presetList', 'ball']) {
    assert.equal(hhHtml.includes(`id="${id}"`), false, `健康提醒的页面不该再有 #${id}`);
  }
});

test('健康提醒的设置面板只剩喝水与睡觉两组', () => {
  const html = fs.readFileSync(path.join(HH, 'page.html'), 'utf8');
  const doc = new (require('jsdom').JSDOM)(html).window.document;

  const groups = doc.querySelectorAll('.field-group');
  assert.equal(groups.length, 2, '应只剩两块：喝水提醒 / 睡觉提醒');

  const titles = Array.from(groups).map((g) => g.querySelector('.fg-title').textContent.trim());
  assert.ok(titles[0].includes('喝水'), `第一组应是喝水，实际：${titles[0]}`);
  assert.ok(titles[1].includes('睡觉'), `第二组应是睡觉，实际：${titles[1]}`);

  const idsIn = (i) => Array.from(groups[i].querySelectorAll('input')).map((el) => el.id);
  assert.deepEqual(idsIn(0), ['inWater'], '喝水组只放喝水间隔');
  assert.deepEqual(idsIn(1), ['inSleep'], '睡觉组只放提醒时间');
});

test('番茄钟的设置面板只放专注节奏', () => {
  const html = fs.readFileSync(path.join(POMO, 'page.html'), 'utf8');
  const doc = new (require('jsdom').JSDOM)(html).window.document;

  const groups = doc.querySelectorAll('.field-group');
  assert.equal(groups.length, 1, '番茄钟只有「专注节奏」一组');
  assert.ok(groups[0].querySelector('.fg-title').textContent.includes('专注'),
    '组名应是专注节奏');

  const ids = Array.from(groups[0].querySelectorAll('input')).map((el) => el.id);
  assert.deepEqual(ids, ['inWork', 'inRest', 'inRounds', 'inPresetName'],
    '只放工作 / 休息 / 轮次 / 预设名');

  // 喝水、睡觉的字段一个都不能留在番茄钟里
  for (const id of ['inWater', 'inSleep']) {
    assert.equal(doc.getElementById(id), null, `番茄钟页面不该有 #${id}`);
  }
});

test('改结构没弄丢 main.js 依赖的任何元素 id', () => {
  // 拆插件 / 拆分组都会动 HTML 结构，JS 靠 id 取元素，少一个就是整页脚本崩
  for (const dir of [HH, POMO]) {
    const name = path.basename(dir);
    const html = fs.readFileSync(path.join(dir, 'page.html'), 'utf8');
    const js = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');
    const doc = new (require('jsdom').JSDOM)(html).window.document;

    const used = new Set();
    for (const m of js.matchAll(/\$\('#([\w-]+)'\)/g)) used.add(m[1]);
    const missing = [...used].filter((id) => !doc.getElementById(id));
    assert.deepEqual(missing, [],
      `${name}: main.js 里用到的这些 id 在页面里找不到：${missing.join(', ')}`);
  }
});

