'use strict';

/**
 * 补齐便携包里剩下的三样东西：运行时 package.json、exe 图标与版本信息、使用说明。
 * 大文件复制交给 robocopy（Node 的 fs.cpSync 在本机复制 250MB 级文件时会崩溃），
 * 这里只写小文本，不碰大目录。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_NAME = '刺猬猫作家助手';
const pkg = require(path.join(ROOT, 'package.json'));
const OUT = path.join(ROOT, 'dist', `${APP_NAME}-v${pkg.version}`);
const APP_DIR = path.join(OUT, 'resources', 'app');
const EXE = path.join(OUT, `${APP_NAME}.exe`);

if (!fs.existsSync(OUT)) {
  console.error('找不到构建目录，请先执行 build-portable.ps1：' + OUT);
  process.exit(1);
}

// ---- 1. 运行时 package.json（必须无 BOM，否则 Electron 解析失败） ----
const appPkg = {
  name: pkg.name,
  productName: APP_NAME,
  version: pkg.version,
  description: pkg.description,
  main: pkg.main,
  license: pkg.license,
  private: true,
};
fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify(appPkg, null, 2) + '\n', 'utf8');
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(APP_DIR, 'LICENSE'));
fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(OUT, 'LICENSE'));
console.log('  package.json 已写入（无 BOM）');

// ---- 2. exe 图标与版本信息 ----
const rceditBin = path.join(ROOT, 'node_modules', 'rcedit', 'bin', 'rcedit-x64.exe');
const icon = path.join(ROOT, 'assets', 'icon.ico');

if (fs.existsSync(rceditBin) && fs.existsSync(EXE)) {
  const args = [
    EXE,
    '--set-icon', icon,
    '--set-version-string', 'ProductName', APP_NAME,
    '--set-version-string', 'FileDescription', '刺猬猫作家助手 - 后台数据整理与评论审查',
    '--set-version-string', 'CompanyName', 'ciweimao-author-tool',
    '--set-version-string', 'OriginalFilename', `${APP_NAME}.exe`,
    '--set-file-version', pkg.version,
    '--set-product-version', pkg.version,
  ];
  try {
    execFileSync(rceditBin, args, { stdio: 'pipe' });
    console.log('  exe 图标与版本信息已写入');
  } catch (e) {
    const msg = e.stderr ? e.stderr.toString() : e.message;
    console.warn('  [警告] 图标写入失败（不影响运行）：' + msg.trim().split('\n')[0]);
  }
} else {
  console.warn('  [警告] 缺少 rcedit 或 exe，跳过图标设置');
}

// ---- 2.5 附带 MCP 桥（AI 接入用；配置片段会指向这个路径）----
const bridgeSrc = path.join(ROOT, 'tools', 'mcp-bridge.js');
const bridgeDir = path.join(OUT, 'resources', 'app', 'tools');
if (fs.existsSync(bridgeSrc)) {
  fs.mkdirSync(bridgeDir, { recursive: true });
  fs.copyFileSync(bridgeSrc, path.join(bridgeDir, 'mcp-bridge.js'));
  console.log('  mcp-bridge.js 已放入 resources/app/tools');
} else {
  console.warn('  [警告] 找不到 tools/mcp-bridge.js，AI 的 MCP 接入会不可用');
}

// ---- 3. 使用说明 ----
const readme = `刺猬猫作家助手 v${pkg.version}
${'='.repeat(50)}

【图文版说明书】
同目录的《功能说明与使用说明.docx》是带截图的傻瓜式手册：按「你实际会做的事」排顺序，
每一步都写了点哪里、会看到什么，另有 12 条常见问题。第一次用建议先看它。

【怎么开始用】
1. 双击「${APP_NAME}.exe」启动。免安装，不用装任何东西。
2. 点右上角「打开作者后台」，在窗口内登录你的刺猬猫作者账号。
   需要过一次极验拖动验证码，这一步只能你本人完成，工具不保存验证码。
3. （可选）在登录页顶部工具条点「记住这次输入」，账号密码经系统加密后
   只存在本机；下次到登录页选账号点「填入」即可，只需再拖一次验证。
4. 左侧「抓取与同步」→「读取作品列表」→ 选中作品 →「开始抓取」。
5. 之后「评论审查」「数据看板」「平台榜单」就有数据了。

【功能一览】
- 码字台     进这一页会自动读取你在刺猬猫上的书和已发布章节，不用手动建作品、也不用填作品号。
             作品按后台书名排列，已发布的章节直接带过来并标「已发」，新建章节自动接在最后一章后面。
             点开某一章时才去后台取正文（第一次稍慢，之后就有本地副本）；想整本离线改就点「下载正文」，
             一次把全书正文拉下来（几十章约一两分钟，已经拉过的会跳过）。正文停手 1.2 秒自动保存，
             Ctrl+S 手动保存，Ctrl+E 专注模式（只留正文）。整本可导出成 TXT（带 BOM，记事本直接打开）。
             数据在 data\\writing\\ 下，一章一个 txt，删掉某个作品目录就是彻底删除。
             如果读不到书，多半是后台登录过期：点空态里的「打开作者后台」登录一次，回来点「重新读取」。
- 投到后台   点「投到后台」会跳到这本书的新建章节页，标题、正文、分卷自动填好，右侧出现一条侧栏。
             这时页面就是你的：插图点工具栏的「图片」，改字直接改，要定时发布就勾页面上的「定时发布」。
             确认后点侧栏的「发布这一章」，或者点页面自己的「发布章节」—— 两个都会先过一遍站点校验。
             触发审核时，侧栏立刻变成敏感词处理：
               · 正文里确实有的词：可以一键「插「.」」拆开，或「近义替换」换成意思相近的词；
               · 正文里根本找不到的词（站点按分词联想的误报）：标「正文里没有」，不改也能直接提交。
             改的是网页里的正文本身，分段与图片都保留；改完自动重新提交，一般一次就能过。
             定时发布也可以在码字台顶栏的「立即发布」里先设好，投递时会自动勾上并填好时间。
- 书库       侧栏点「书库」看所有书的卡片：章数、总字数、今日字数、是否已绑后台，点卡片进去写。
             支持新建书籍、导入 TXT / JSON（自动按「第N章 / 第N卷」切分），也能一键「同步后台」
             把作者库里的作品读下来。章节多的时候用侧栏顶部的搜索框按标题过滤。
- 码字工具   编辑器顶部有「排版」与「查找」：
             排版 = 合并多余空行 + 统一段首两个全角空格（一次整理整章）；
             查找 = Ctrl+F 打开，支持下一个 / 替换 / 全部替换。
             底部实时显示本次码字字数、码字速度（字/时）、码字时长；
             键盘敲的和输入法上屏的才算，粘贴与拖入只计本章字数、不计速度。
- 评论审查   按规则打分（辱骂/攻击/广告/剧透/刷屏/指控），分高/中风险；
             可按作品筛选、按读者查看；支持逐条处理与批量处理；误判可一键剔除。
             设置里可切「标准 / 严格」：严格会把「尴尬 / 暴死 / 扑街」这类负面评价也计入，容易误伤。
- 数据看板   字数、收藏、总订阅、新增订阅、均订、日均追订；选中单本可看折线图。
- 章节导出   把某本书的章节导出为 TXT，可一键全部或只导出勾选的。
- 平台榜单   点击、收藏、推荐、订阅、月票、吐槽、新书、刀片、更新九类榜单，
             含周榜/月榜与名次升降（公开页面，不用登录）；
             点书名会用浏览器打开该书页面。
- 喵语数据   内嵌第三方数据站「喵语」，只保留刺猬猫栏目：试水推榜（七项数据、可按渠道/周次/排序查看，
             点书名展开封面简介）与万收首订榜。第三方站点偶尔打不开，页面会给出提示。
             这页不会自动刷新（只在打开时加载一次，需要新数据点「刷新」），因为喵语是个人小站，
             经不起轮询。
- 清小红点   概览页一键清除作者信箱的未读红点，可选连其他分页一起清。
- 深色模式   侧栏底部一键切换；设置里可选浅色 / 深色 / 跟随系统。
             用了美化包（扩展主题）期间，这个切换和「深色配色」会一起灰掉锁定，
             点不动是为了保护美化包；到设置里选「使用内置主题」就恢复。
- 美化包     软件自带一套示例主题包「达妮娅 · 虚无之泡」，功能中心里已装好并启用；
             到设置 →「外观 → 扩展主题」里选「布景之形」（浅色）或「幻灭之形」（深色）即可使用，
             不需要就在功能中心把它停用，内置配色不受影响。也可以导入别人做的主题包（ZIP）。
             想做属于自己的：看随包的《美化包制作说明.md》——里面列清需要哪几张图、
             多大尺寸、怎么一次性说给自己的 AI，照着做就能出一个自己的包。
- 数据位置   设置 → 数据保存位置：可以把作品、正文、评论数据指到别的盘（例如 D:\写作）。
             换位置只影响之后读写的目录，旧目录里的文件不会被删除或搬走；改回原目录就能看到旧数据。
- 插件中心   想把某个功能做成自己的？点「创建开发模板」会生成一个示例插件（manifest.json + page.html
             + main.js + style.css / style.css 可省），改完点「重新加载」即可运行。插件跑在沙箱 iframe 里，
             只能用清单里声明、宿主放行的接口（读当前章节 / 改正文 / 读统计 / 自己的存储），
             拿不到 Node、文件系统和我们的界面。安装别人的插件前请确认来源可信。
             ★ 想自己写、或者让 AI 帮你写：看随包的《插件开发说明.md》——里面有全部接口签名、
               沙箱红线、常见错误对照，以及一段可以直接复制给 AI 的「任务书」。
             ★ 随包还带了一个能直接导入的示例：插件示例\chapter-tools（导入方法见该文件夹的 README.md）。

【让 AI 读数据（可选）】
设置 → AI 接入：
- 只想要个表格/摘要：点「生成 AI 素材包」，把文件夹里的 .md 粘给 AI、.csv 上传即可，
  不需要打开开关，也不需要装任何东西。
- 想让 agent 自动查：打开「允许本机 AI 读取数据」，复制页面上的 MCP 配置粘到 agent 里。
  只监听 127.0.0.1、每次启动换令牌、只读，没有删除/禁言接口。
- 详细步骤见《功能说明与使用说明.docx》第 7.6 节，或设置页「AI 接入」面板里的说明。

【处理评论必须知道的】
- 单条：点右侧「处理」，下方出现执行单；默认「交给工具」，也可切「我自己来」。
- 批量：勾选条目（或「全选高风险」）后出现批量条，选动作 →「执行选中」，
  逐条串行发出，跑完给成功/失败清单，中途可停止。
- 觉得是误判，点「剔除」就移出列表；统计卡「已剔除」可一键恢复。
- 默认「演练模式」：只生成请求清单不真的发出。第一次请先演练看一遍。
- 关掉演练后，单条要点确认条、批量会弹一次确认框，确认后才发出。
- 每次动作都会写入执行记录（data\\actions-log.json），发完还会自动复核一次。
- 「拉黑」= 删除这条 + 禁言这个人（平台没有独立拉黑接口，禁言本身跨作品生效）。
- 删除不可撤销；禁言可在后台「禁言回收站」解除。

【第一次打开是空的】
工具不预置任何数据，需要你登录并抓取一次才会显示内容。
数据看板的对比要累计两天以上的快照才有意义。
平台每天早上 6 点换日，隔天再看就是完整的日变化。

【数据存在哪】
%APPDATA%\\ciweimao-author-tool\\
（把这个路径粘到资源管理器地址栏即可打开）
  data\\         抓取的评论、每日快照、榜单历史、执行记录、加密的密码本
  diagnostics\\  页面结构诊断包（功能对不上页面时才需要）
卸载：删掉本文件夹即可，不会在系统里留下别的东西。
注意：整个目录含登录凭据，不要整个发给别人；备份只需 data 子目录。

【登录有效期】
会话约 2 小时、滑动续期；超过 2 小时没用需要重新登录一次。

【遇到问题】
- 页面空白或读不到数据：多半是登录过期，重新点「打开作者后台」登录一次。
- 提示「已在运行」：工具只允许开一个窗口，到任务栏找已经开着的那个。
- 平台改版导致解析失效：diagnostics 目录会留下页面快照，把它发给工具作者即可补规则。

【反馈与联系】
作者：二组-坚持更新的阿烬
技术支持：三组-汐
审查功能：二组-MINI 喵~
联系 QQ：1834671434（用着不顺手、想加功能，直接加这个号说）

【边界声明】
0. 本工具完全免费、开源，不收取任何费用，也不进行任何性质的盈利；
   若有人以本工具的名义向你收费，那一定不是作者本人，请勿支付。
1. 除执行台中由你确认后发出的删除/禁言外，其余功能均为只读，不改动平台内容。
2. 账号密码不经过任何第三方服务器；密码本用 Windows 系统级加密，换电脑解不开。
3. 这是第三方工具，非刺猬猫官方产品，使用风险自担。
`;

fs.writeFileSync(path.join(OUT, '使用说明.txt'), '\ufeff' + readme, 'utf8');
console.log('  使用说明.txt 已写入');

// ---- 4. 随包的正式文档（白名单） ----
// 这里原本是「把 docs/ 里所有文件倒进包根目录」。后果是用户一解压就看见
// 十几个 更新说明-v0.13.0 / v1.0.0…v1.0.7、修改说明、测试与修复说明、
// 稿费统计后台同步操作说明、CI 与自动发布……全都不该出现在用户的下载里，
// 同一份 AI 教程还会以两个名字各出现一次。
//
// 改白名单：只放用户真正会翻开的东西 ——
//   使用说明.txt（上面生成，第一入口）、功能说明与使用说明.docx、安全说明和使用说明.docx、
//   插件开发说明.md（插件中心里会让用户照它写插件，verify-portable 也要求它在）。
// 更新说明只在仓库的 docs/ 里存档、作为 Release 正文，不进安装包。
const SHIPPED_DOCS = [
  '功能说明与使用说明.docx',
  '安全说明和使用说明.docx',
  '插件开发说明.md',
  '美化包制作说明.md',
];
for (const name of SHIPPED_DOCS) {
  const from = path.join(ROOT, 'docs', name);
  if (!fs.existsSync(from)) {
    console.warn(`  [提示] 缺少 docs/${name}，跳过`);
    continue;
  }
  fs.copyFileSync(from, path.join(OUT, name));
  console.log(`  ${name} 已附上`);
}

const sampleSrc = path.join(ROOT, 'plugins-sample', 'chapter-tools');
const sampleDst = path.join(OUT, '插件示例', 'chapter-tools');
if (fs.existsSync(sampleSrc)) {
  fs.rmSync(path.join(OUT, '插件示例'), { recursive: true, force: true });
  fs.mkdirSync(sampleDst, { recursive: true });
  for (const f of fs.readdirSync(sampleSrc)) {
    const from = path.join(sampleSrc, f);
    if (fs.statSync(from).isFile()) fs.copyFileSync(from, path.join(sampleDst, f));
  }
  console.log('  插件示例\chapter-tools 已附上（' + fs.readdirSync(sampleDst).length + ' 个文件）');
} else {
  console.warn('  [提示] 未找到 plugins-sample/chapter-tools，跳过');
}

console.log('');
console.log('便携包就绪：' + OUT);
