# CI 与自动发布

项目使用 GitHub Actions，入口为 `.github/workflows/ci.yml`。

## 自动运行

- 每次推送或 PR：检查 JavaScript 语法、JSON、界面版本一致性，并运行基础逻辑测试。
- 推送 main 或手动运行工作流：在 Windows 上安装锁定依赖、构建并检查免安装目录，生成 ZIP 和 SHA256 校验文件。
- 推送 `v*` 标签：标签必须与 `package.json` 一致。构建通过后，自动创建 GitHub Release，上传免安装 ZIP 与校验文件。
- 普通提交不会创建 Release。Actions 页面运行详情中的 `windows-portable` 是测试安装包，保留 14 天。

构建会附带内置插件、`docs/` 文档、MCP 桥与插件示例，不会读取开发电脑的用户数据。稿费计算器位于 `bundled-plugins/`，随程序安装，不再额外附带独立 ZIP。

## 产出的两个包

同一次构建会产出两个 ZIP，用途不同，都需要随 Release 一起发布：

| 文件 | 内容 | 压缩后 | 用途 |
| --- | --- | --- | --- |
| `ciweimao-writer-tool-v<版本>-windows-x64.zip` | 完整便携包：exe、Chromium 运行时、`resources/app` | 约 140 MB | 新用户安装、Electron 运行时升级 |
| `ciweimao-writer-tool-v<版本>-app.zip` | 只含 `resources/app` 里的应用代码 | 约 1.2 MB | 软件内置的自动更新 |

客户端读 `update/latest.json` 里的 `type` 决定走哪条路径：

- `type: "app"` → 下载小包，替换 `resources\app`，失败自动回滚。日常发版用这个。
- `type: "full"` → 只把包下到临时目录并提示路径，由用户自行解压覆盖。改了 Electron 版本时用这个。

`app` 包的打包必须用 .NET 的 `[IO.Compression.ZipFile]::CreateFromDirectory(..., $false)`，最后那个参数是「不含基目录」。用 `Compress-Archive` 会多套一层 `app\`，解压后覆盖到 `resources\app` 会变成 `app\app\...`，更新就会失败。

## 更新说明怎么写

Release 正文优先取 `docs/更新说明-<tag>.md`（例如 `docs/更新说明-v0.14.1.md`），文件内容就是最终正文，CI 原样使用、不做转换：

- 首行写 `## vX.Y.Z 更新内容`，与 Release 标题区分开
- 紧跟一行引用，说明这次相较哪个版本
- 按模块分 `###` 小节（如「评论与间贴」「平台榜单」「稳定性」），每条一句话
- 面向用户写结果，不写实现细节

**发版前必须把说明文件提交到 tag 所指的提交中**。也可以在发布分支上创建 tag，CI 会读取该提交中的说明。

## 发布步骤

先同步 main，将 `package.json` 和界面版本号一并更新。提交代码和相应锁文件后：

```sh
git push origin main
git tag v0.14.0
git push origin v0.14.0
```

示例版本号需替换成实际版本。已发布的标签不要重复使用；重新发版请递增版本号。

如明确决定同版本修复重发，需要记录旧 tag 指向，使用带预期旧值的 tag 推送更新它。发布任务支持对已有 Release 使用 `--clobber` 替换附件并更新说明；附件上传成功后再更新清单的实际 SHA256。相同应用版本不会触发已安装该版本客户端的更新提示，需在发布说明中提示手动使用完整包升级。

首次工作流应在仓库 Actions 页面检查结果。无需单独配置个人令牌，发布使用 GitHub 提供的临时令牌；仅发布任务拥有写权限。

从 v1.0.5 开始，Release 发布成功后，CI 会根据实际 app 更新包的大小和 SHA256 更新主分支的 `update/latest.json`，保留历史更新说明。该提交不触发重复打包。发布分支的源代码不会因此自动合并到主分支。若主分支清单已经指向更高版本，旧版本流程会拒绝覆盖。

## 本地检查与打包

Windows 上安装 Node.js 24 后，在项目根目录执行：

```sh
npm ci
npm run install:electron
npm run check
npm test
npm run build
npm run pack
npm run verify:portable
```

构建会重建项目内 `dist/`，需要保留的旧成品请先放到其他目录。工程根目录的 package.json 必须保留 scripts 和开发依赖；成品包中的精简 package.json 只供运行，不要反向覆盖工程文件。

CI 不连接作者账号，也不执行真实投稿或评论处置。这些交互仍需人工验收。
