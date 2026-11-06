'use strict';

/**
 * 更新流程演练：只做判定与脚本生成，**不改动任何文件、不启动任何进程**。
 *
 * 用途有两个：
 * 1. 改完清单或版本号后，先看一眼「会提示哪些版本、跨几个版本」是否符合预期；
 * 2. 检查 run-update.cmd 的内容 —— 这个脚本一旦跑起来就会替换程序目录，
 *    在执行之前让人先读一遍比事后回滚便宜得多。
 *
 * 运行：node tools/dry-run-update.js [清单路径] [当前版本]
 * 默认读仓库里的 update/latest.json，当前版本取 package.json。
 */

const fs = require('fs');
const path = require('path');
const updater = require('../src/main/updater.js');

const ROOT = path.join(__dirname, '..');
const manifestPath = process.argv[2] || path.join(ROOT, 'update', 'latest.json');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const current = process.argv[3] || pkg.version;

const line = (s) => console.log(s == null ? '' : s);

line('=== 1. 读取清单 ===');
let manifest;
try {
  manifest = updater.normalizeManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
} catch (e) {
  line(`清单不可用：${e.message}`);
  process.exit(1);
}
line(`清单文件：${manifestPath}`);
line(`目标版本：v${manifest.version}`);
line(`包类型　：${manifest.type === 'full' ? 'full（完整包，需用户手动解压）' : 'app（替换 resources\\app）'}`);
line(`包大小　：${updater.humanSize(manifest.size)}（${manifest.size} 字节）`);
line(`校验值　：${manifest.sha256}`);
line(`下载地址：${manifest.urls.length} 个`);
manifest.urls.forEach((u, i) => line(`  ${i + 1}. ${u}`));

line('');
line('=== 2. 版本对比 ===');
let cmp;
try {
  cmp = updater.compareVersions(manifest.version, current);
} catch (e) {
  line(`版本号无法比较：${e.message}`);
  process.exit(1);
}
line(`当前版本 v${current} → 清单版本 v${manifest.version}`);
if (cmp <= 0) {
  line('结论：清单版本不高于当前版本，启动时不会出现更新横幅。');
} else {
  line(`结论：会提示更新。`);
}

line('');
line('=== 3. 跨版本变更集 ===');
const changes = updater.pickChanges(current, manifest.version, manifest.changes);
if (changes.fallback) {
  line('没有可展示的变更条目 → 界面显示「作者未提供本次更新说明」+ 发布页入口');
} else {
  line(`跨 ${changes.across} 个版本，共 ${changes.total} 条，标题为「${changes.across > 1 ? `本次更新（跨 ${changes.across} 个版本）` : '本次更新'}」`);
  changes.bundle.forEach((g) => {
    line(`  v${g.version}${g.date ? ' · ' + g.date : ''}`);
    g.items.forEach((it) => line(`    ${it}`));
  });
}

line('');
line('=== 4. 替换脚本（dry-run，未执行） ===');
const sample = {
  pid: 12345,
  appDir: 'C:\\Users\\<你>\\AppData\\Local\\刺猬猫作家助手\\resources\\app',
  newDir: 'C:\\Users\\<你>\\AppData\\Local\\Temp\\cw-update\\' + manifest.version + '\\new',
  bakDir: 'C:\\Users\\<你>\\AppData\\Local\\刺猬猫作家助手\\resources\\app.bak-' + current,
  exePath: 'C:\\Users\\<你>\\AppData\\Local\\刺猬猫作家助手\\刺猬猫作家助手.exe',
  args: '',
  dataDir: 'C:\\Users\\<你>\\AppData\\Roaming\\刺猬猫作家助手\\data',
  to: manifest.version,
  waitSeconds: 15,
};
const cmd = updater.buildUpdateCommand(sample);
line(`脚本长度 ${cmd.length} 字符，写入 %TEMP%\\cw-update\\run-update.cmd`);
line('--------------------------------------------------------------');
line(cmd);
line('--------------------------------------------------------------');
line('');
line('执行顺序检查：');
const idxWait = cmd.indexOf(':wait');
const idxGo = cmd.indexOf(':go');
const idxProbe = cmd.indexOf(':probe');
const idxOk = cmd.indexOf(':ok');
const idxRollback = cmd.indexOf(':rollback');
line(`  等旧进程退出 → 备份 → 覆盖 → 等新版本标记 → 成功清理 / 失败回滚`);
line(`  wait(${idxWait}) < go(${idxGo}) < probe(${idxProbe}) < ok(${idxOk}) / rollback(${idxRollback})：${
  idxWait >= 0 && idxWait < idxGo && idxGo < idxProbe && idxProbe < idxOk && idxProbe < idxRollback ? '顺序正确' : '顺序异常'
}`);
line(`  备份在覆盖之前：${cmd.indexOf('move /y "%APPDIR%" "%BAKDIR%"') < cmd.indexOf('robocopy "%NEWDIR%"') ? '是' : '否'}`);
line(`  备份失败即中止：${cmd.includes(':backupfail') ? '有保护' : '缺保护'}`);
