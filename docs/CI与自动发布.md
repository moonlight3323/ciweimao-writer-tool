# CI 与自动发布

项目使用 GitHub Actions，入口为 `.github/workflows/ci.yml`。

## 自动运行

- 每次推送或 PR：检查 JavaScript 语法、JSON、界面版本一致性，并运行基础逻辑测试。
- 推送 main 或手动运行工作流：在 Windows 上安装锁定依赖、构建并检查免安装目录，生成 ZIP 和 SHA256 校验文件。
- 推送 `v*` 标签：标签必须与 `package.json` 一致。构建通过后，自动创建 GitHub Release，上传免安装 ZIP 与校验文件。
- 普通提交不会创建 Release。Actions 页面运行详情中的 `windows-portable` 是测试安装包，保留 14 天。

构建会附带内置插件、`docs/` 文档、MCP 桥、插件示例及 `plugins/` 内已提交的独立插件 ZIP，不会读取开发电脑的用户数据。

## 发布步骤

先同步 main，将 `package.json` 和界面版本号一并更新。提交代码和相应锁文件后：

```sh
git push origin main
git tag v0.13.2
git push origin v0.13.2
```

示例版本号需替换成实际版本。已发布的标签不要重复使用；重新发版请递增版本号。

首次工作流应在仓库 Actions 页面检查结果。无需单独配置个人令牌，发布使用 GitHub 提供的临时令牌；仅发布任务拥有写权限。

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
