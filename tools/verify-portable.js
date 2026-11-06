'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const out = path.join(root, 'dist', `刺猬猫作家助手-v${pkg.version}`);
const app = path.join(out, 'resources/app');
for (const file of ['刺猬猫作家助手.exe', '使用说明.txt', '功能说明与使用说明.docx', '插件开发说明.md', 'LICENSE', 'resources/app/LICENSE', 'resources/app/tools/mcp-bridge.js']) {
  assert.ok(fs.statSync(path.join(out, file)).size > 0, `打包缺少 ${file}`);
}
const runtimePkg = JSON.parse(fs.readFileSync(path.join(app, 'package.json'), 'utf8'));
assert.equal(runtimePkg.version, pkg.version);
assert.equal(runtimePkg.license, pkg.license);
function compare(source, target) {
  for (const item of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, item.name), to = path.join(target, item.name);
    if (item.isDirectory()) compare(from, to);
    else assert.ok(fs.readFileSync(from).equals(fs.readFileSync(to)), `打包文件不一致：${to}`);
  }
}
for (const dir of ['src', 'assets', 'bundled-plugins']) compare(path.join(root, dir), path.join(app, dir));
console.log(`免安装目录检查通过：${out}`);
