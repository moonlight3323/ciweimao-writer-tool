'use strict';

/**
 * 构建免安装便携版：把 Electron 运行时与我们自己的代码组装成一个可直接双击的目录。
 *
 * 这么做而不用 electron-builder 的原因：本机网络对额外二进制的下载不可靠，
 * 而 Electron 的加载规则很简单 —— exe 旁边有 resources/app 就直接跑我们的代码。
 * 所以重命名 exe + 放置 app 目录即可，全程离线且可控。
 *
 * 复制一律走 robocopy：本机 fs.cpSync 复制 250MB 级目录会直接段错误退出
 * （进程没了，连异常都抛不出来，只有一行"构建目录"），换成 robocopy 才稳。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAME = '刺猬猫作家助手';
const pkg = require(path.join(ROOT, 'package.json'));
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');
const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, `${APP_NAME}-v${pkg.version}`);

const KEEP_LOCALES = new Set(['zh-CN.pak', 'en-US.pak']);

function step(msg) {
  console.log('  ' + msg);
}

/** robocopy 用退出码表达结果：0~7 都是成功（1=复制了新文件，2=有额外文件…） */
function robocopy(src, dst) {
  const args = [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/R:1', '/W:1'];
  try {
    execFileSync('robocopy', args, { stdio: 'pipe' });
  } catch (e) {
    if (typeof e.status === 'number' && e.status < 8) return;
    const out = e.stdout ? e.stdout.toString() : '';
    throw new Error(`robocopy 失败（exit ${e.status}）：${out.slice(-400) || e.message}`);
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

(async function main() {
  if (!fs.existsSync(ELECTRON_DIST)) {
    console.error('找不到 Electron 运行时：' + ELECTRON_DIST);
    process.exit(1);
  }

  console.log('构建目录：' + OUT);
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  // ---- 1. 复制 Electron 运行时 ----
  robocopy(ELECTRON_DIST, OUT);
  step('已复制 Electron 运行时');

  // ---- 2. exe 改名 ----
  const oldExe = path.join(OUT, 'electron.exe');
  const newExe = path.join(OUT, `${APP_NAME}.exe`);
  fs.renameSync(oldExe, newExe);
  step('可执行文件改名为 ' + path.basename(newExe));

  // ---- 3. 精简不需要的运行时文件 ----
  const defaultApp = path.join(OUT, 'resources', 'default_app.asar');
  if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp, { force: true });

  const localesDir = path.join(OUT, 'locales');
  let dropped = 0;
  if (fs.existsSync(localesDir)) {
    for (const f of fs.readdirSync(localesDir)) {
      if (!KEEP_LOCALES.has(f)) {
        fs.rmSync(path.join(localesDir, f), { force: true });
        dropped++;
      }
    }
  }
  step(`移除默认应用与 ${dropped} 个语言包`);

  // ---- 4. 放入应用代码 ----
  const appDir = path.join(OUT, 'resources', 'app');
  fs.mkdirSync(appDir, { recursive: true });
  robocopy(path.join(ROOT, 'src'), path.join(appDir, 'src'));
  robocopy(path.join(ROOT, 'assets'), path.join(appDir, 'assets'));

  // 运行时 package.json：去掉 dev 依赖与脚本，避免被误当作可安装工程
  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: pkg.name,
        productName: APP_NAME,
        version: pkg.version,
        description: pkg.description,
        main: pkg.main,
        private: true,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  step('已放入应用代码（src + assets）');

  // ---- 5. 改写 exe 的图标与版本信息 ----
  try {
    const rcedit = require('rcedit');
    await rcedit(newExe, {
      icon: path.join(ROOT, 'assets', 'icon.ico'),
      'version-string': {
        CompanyName: 'ciweimao-author-tool',
        FileDescription: '刺猬猫作家助手 - 后台数据整理与评论审查',
        ProductName: APP_NAME,
        OriginalFilename: `${APP_NAME}.exe`,
      },
      'file-version': pkg.version,
      'product-version': pkg.version,
    });
    step('已写入 exe 图标与版本信息');
  } catch (e) {
    console.warn('  [警告] 改写图标失败（不影响运行）：' + e.message);
  }

  // ---- 6. 使用说明 ----
  const readme = `刺猬猫作家助手 v${pkg.version}
==================================================

【怎么开始用】
1. 双击「${APP_NAME}.exe」启动（免安装，不用装任何东西）
2. 点右上角「打开作者后台」，在窗口内登录你的刺猬猫作者账号
   （需要过一次极验拖动验证码，这一步只能你本人完成）
3. 左侧「抓取与同步」→「读取作品列表」→ 选中作品 →「开始抓取」
4. 左侧「数据看板」「评论审查」「平台榜单」查看结果

【第一次打开是空的】
工具不预置任何数据，需要你登录并抓取一次才会显示内容。
数据看板里的「较上次」对比要累计两天以上的快照才有意义，
平台每天早上 6 点换日，所以隔天再看就是完整的日变化。

【数据存在哪】
%APPDATA%\\ciweimao-author-tool\\
（在资源管理器地址栏粘贴即可打开）
- data\\          抓取的评论、每日快照、榜单历史
- diagnostics\\   页面结构诊断包（站点改版时才需要）
卸载：删掉本文件夹即可，不会在系统里留下其他东西。

【三条要知道的边界】
1. 本工具是只读的。不会删除评论、不会禁言、不会拉黑任何人。
2. 不保存账号密码。登录状态由内置浏览器维护，只存在本机。
3. 这是第三方工具，非刺猬猫官方产品，使用风险自担。

【遇到问题】
- 页面空白或数据读不到：多半是登录过期，重新点「打开作者后台」登录一次。
- 提示「已在运行」：工具只允许开一个窗口，请到任务栏找已经开着的那个。
- 平台改版导致解析失效：需要重新测绘页面结构，联系给你这个工具的人。
`;

  const bom = '\ufeff';
  fs.writeFileSync(path.join(OUT, '使用说明.txt'), bom + readme, 'utf8');
  step('已写入使用说明.txt');

  // ---- 汇总 ----
  const size = dirSize(OUT);
  console.log('');
  console.log('构建完成');
  console.log('  路径：' + OUT);
  console.log('  大小：' + (size / 1024 / 1024).toFixed(1) + ' MB（未压缩）');
  console.log('  文件数：' + countFiles(OUT));
})();

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else n++;
    }
  };
  walk(dir);
  return n;
}
