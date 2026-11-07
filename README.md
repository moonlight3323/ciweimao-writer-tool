# 刺猬猫作家助手

给刺猬猫（ciweimao）作者用的 Windows 桌面工具：把后台的零散数据收拢成看板、按规则筛出该处理的间贴评论、
在本地码字并把稿子一键填进后台的发布页，发布前顺带把站点报的敏感词处理掉。

> **这个仓库只放源码。** 免安装的成品包体积 140MB+，放在 [Releases](../../releases) 里下载，
> 不要提交进仓库（Git 存二进制会让仓库迅速膨胀，且每次都存一整份）。

## 许可

本项目采用 **GNU Affero General Public License v3.0（AGPL-3.0）**：

- 可以自由**使用、修改、分发**，商业使用也可以
- 但**修改后的版本必须同样以 AGPL-3.0 开源**，通过网络对外提供服务时同样适用
- 分发时需保留版权声明与许可文本，完整条款见 [LICENSE](LICENSE)

一句话：拿它做你自己的工具、改快捷键、加功能都没问题；把改过的版本闭源打包收费，不行。

## 功能

| 模块 | 做什么 |
|---|---|
| 创作中心 / 码字台 | 作品卡片书库、分卷分章、自动保存、一键排版、查找替换、实时码字统计 |
| 一键投到后台 | 把这一章填进后台的新建章节页（标题 / 正文 / 分卷 / 定时），站点自己的插图、@ 功能照旧 |
| 敏感词处理 | 站点报词后列成清单，可插「.」/ 换近义 / 直接删，一键改进正文，改完再点发布 |
| 评论审查 | 抓间贴自动打分（辱骂 / 引战 / 广告 / 剧透 / 无凭据指控），支持批量处理、误判剔除，默认演练 |
| 数据看板 | 字数、收藏、总订阅、新增订阅、均订、日均追订，按 6:00 结算日采集 |
| 章节导出 | 整本或勾章导出 TXT，正文同时归档到本地 |
| 平台榜单 / 喵语数据 | 九类公开榜单、试飞推榜与万收首订，无需登录 |
| 插件中心 | 插件可扩展侧边导航与编辑器指标；随包预装「稿费计算器」，支持沙箱内运行 |
| 密码本 | 用 Windows 系统级加密保存账号，只代填不代提交 |

## 快速开始（开发）

需要 Windows + Node.js 18 以上。

```bash
git clone <本仓库地址> ciweimao-writer-tool
cd ciweimao-writer-tool
npm install          # 会下载 Electron 44（100MB+，国内建议配镜像）
npm start
```

Electron 下载慢可以先设镜像：

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install
```

### 两个必知的环境坑

1. **`ELECTRON_RUN_AS_NODE`**：如果继承了这个环境变量，Electron 会当纯 Node 跑，表现为「闪退 / 报 bad option」。
   命令行里用 `env -u ELECTRON_RUN_AS_NODE npm start`，或者干脆在干净终端里启动。
2. **GPU 进程沙箱**：装了虚拟显示适配器（向日葵 OrayIddDriver / GameViewer）的机器上，
   Chromium 的 GPU 沙箱起不来，日志是 `FATAL: GPU process isn't usable. Goodbye.`。
   `src/main/main.js` 顶部已内置 `--disable-gpu-sandbox`，正常不会遇到。

## 目录结构

```
├─ src/
│  ├─ main/           主进程：窗口、原生视图、数据层、插件加载、密码本
│  ├─ preload/        contextBridge 暴露面（不含任何取密码的方法）
│  ├─ renderer/       界面（app.js 承载创作中心与插件宿主）
│  └─ adapters/       注入到平台页面里执行的解析/填充脚本
├─ assets/            图标等静态资源
├─ bundled-plugins/   随包预装的插件（如稿费计算器）
├─ plugins-sample/    可直接导入的示例插件（章节小工具）
├─ tools/             构建与辅助脚本
├─ docs/              全部说明文档
├─ package.json
└─ _release/          （本地）成品包，已在 .gitignore 中排除
```

## 文档

| 文件 | 读者 |
|---|---|
| `docs/功能说明与使用说明.docx` | 普通使用者：图文傻瓜手册，10 步总览 + 12 条常见问题 |
| `docs/使用说明.txt` | 快速开始（纯文字） |
| `docs/安全说明和使用说明.docx` | 安全边界与操作说明 |
| `docs/AI创作辅助教程.docx` | 让 AI 读本地数据的三种用法 |
| `docs/稿费统计后台均订同步操作说明.md` | 稿费统计：刷新后台均订、作品对应与独立插件安装 |
| `docs/插件开发说明.md` | 想写插件的人 / 让 AI 代写插件的人 |
| `docs/测试与修复说明-2026-11-05.md` | 一次完整回归发现的 bug 与成因 |

## 插件

插件跑在 `sandbox` iframe 里，只能通过宿主暴露的 `PluginAPI` 与软件交互，拿不到 Node、文件系统与界面 DOM。

- 插件目录：`manifest.json` + `page.html` + `main.js` + `style.css` + `README.md`（预装插件还可带 `background.js`）
- `manifest.json` 支持 `contributes.navigation`（在左侧加一项）、`contributes.editorStat`（在编辑器里显示指标）与 `contributes.floatingWidget`（让插件自己的 iframe 悬浮球常驻应用顶层）
- 权限：`editor.read` / `editor.write` / `stats.read` / `stats.author` / `ui.editorStat`
- 插件 API 1.1.0 提供就绪握手、事件订阅、独立常驻 iframe 和 `floating.configure / bindDrag / setExpanded`；切换页面与主题时保留常驻插件状态
- 随包预装放在 `bundled-plugins/`，首次启动会按版本号安装到用户数据目录，升级时不覆盖用户改动

接口细节、沙箱红线与常见错误对照见 `docs/插件开发说明.md`。

## 发版

```bash
npm install
node tools/build-portable.js     # 组装 dist/刺猬猫作家助手-v<版本>（Electron 运行时 + 源码）
node tools/finish-portable.js    # 写 package.json、exe 图标与版本信息、使用说明
# 压缩 dist 里的目录，上传到 GitHub Releases
```

> 打包脚本里的 `fs.rmSync` 会被某些环境注入的 safe-delete 钩子拦住，
> 报 `trash-failed` 时用 `env -u NODE_OPTIONS node tools/build-portable.js`。

## 免责声明

- 这是第三方工具，**不是刺猬猫官方产品**。
- 除「评论审查」里由你确认后执行的删除 / 禁言外，其余功能均为只读；所有写操作默认演练模式。
- 软件完全免费，不收费、不盈利；若有人以此收费，与作者无关。
- 代码以 **AGPL-3.0** 授权：可自由使用与修改，衍生作品需同样开源，详见 [LICENSE](LICENSE)。
