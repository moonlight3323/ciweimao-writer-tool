# 独立插件

本目录用于存放可单独安装的插件及其使用说明。每个插件使用以插件 ID 命名的独立子目录。

插件目录通常包含 `manifest.json`、`page.html`、`main.js`、`style.css` 和 `README.md`，按需提供 `background.js`。权限和开发接口见 [插件开发说明](../docs/插件开发说明.md)。

软件随包预装插件位于 `bundled-plugins/`，开发示例位于 `plugins-sample/`。

## 可用插件

- [稿费计算器 v1.1.2](income-calculator/README.md)：按作品设置订阅数，预估当日、7 日、30 日稿费与全勤奖励。页面金额均为预估，稿费以实际发放为准。

请勿提交用户作品、插件设置、账号信息或其他个人数据。插件 ZIP 安装包建议发布到 GitHub Releases；仓库默认忽略 ZIP 文件。
