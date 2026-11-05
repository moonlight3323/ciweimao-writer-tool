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
console.log(`语法及配置检查通过：${checked} 个脚本`);
