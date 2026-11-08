'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.join(__dirname, '..');
let checked = 0;
function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) walk(file);
    else if (file.endsWith('.js')) { execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' }); checked++; }
    else if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}
for (const dir of ['src', 'tools', 'tests', 'bundled-plugins', 'plugins-sample']) walk(path.join(root, dir));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('版本号必须为 x.y.z');
const html = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
if (!html.includes(`v${pkg.version}`)) throw new Error('界面版本与 package.json 不一致');
const bundledIncome = JSON.parse(fs.readFileSync(path.join(root, 'bundled-plugins/income-calculator/manifest.json'), 'utf8'));
if (bundledIncome.id !== 'income-calculator') throw new Error('内置稿费插件清单无效');

// 番茄钟与健康提醒是一对：番茄钟独占悬浮球，健康提醒只管喝水/睡觉。
// 这条检查防止有人把两者又合并回去，或者给健康提醒再加一颗球（会叠在番茄钟上面）。
const pomodoro = JSON.parse(fs.readFileSync(path.join(root, 'bundled-plugins/pomodoro/manifest.json'), 'utf8'));
if (pomodoro.id !== 'pomodoro' || !pomodoro.contributes.floatingWidget || pomodoro.contributes.navigation) {
  throw new Error('内置番茄钟必须启用常驻悬浮能力，且不贡献侧边栏导航');
}
const health = JSON.parse(fs.readFileSync(path.join(root, 'bundled-plugins/health-helper/manifest.json'), 'utf8'));
if (health.id !== 'health-helper') throw new Error('内置健康提醒清单无效');
if (health.contributes.floatingWidget) {
  throw new Error('健康提醒不该再挂悬浮球：球归番茄钟独占，否则两个球会叠在一起');
}
if (health.contributes.navigation) {
  throw new Error('健康提醒不该贡献侧边栏导航');
}
const pluginDir = path.join(root, 'plugins', 'income-calculator');
if (fs.existsSync(pluginDir) && fs.readdirSync(pluginDir).some((file) => file.endsWith('.zip'))) {
  throw new Error('稿费插件必须作为内置插件发布，不能保留独立 ZIP');
}
console.log(`语法及配置检查通过：${checked} 个脚本`);
