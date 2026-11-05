# 章节小工具（插件示例）

刺猬猫作家助手 v0.12.1 的示例插件，用来演示插件能做什么、怎么写。

## 它能做什么

| 功能 | 用到的接口 |
|---|---|
| 显示本书 / 本章 / 今日码字与进度 | `stats.get()`、`editor.getContext()` |
| 末尾插入分隔符 `＊　＊　＊` | `editor.insertText(text, 'end')` |
| 给选中文字套上 `【】` | `editor.getContext().selectedText` + `editor.setContent()` |
| 每天的目标字数（关掉软件也记得） | `storage.get/set()` |
| 顶部状态栏提示 | `app.notify()` |
| 跟随软件深浅色 | `app.info().theme` |

## 怎么装

1. 打开软件 → 左侧「插件中心」
2. 点「导入插件」→ 选这个文件夹（`chapter-tools`）
3. 列表里出现「章节小工具」→ 点开 → 先在「码字台」打开一章再点按钮

## 怎么改

四个文件，改完点插件页右上角「刷新插件」：

- `manifest.json` — 改 id / 名称 / 权限（**改了 id 就要把文件夹名一起改**）
- `page.html` — 界面骨架（**不要在里面写 `<script>`，会被剥掉**）
- `main.js` — 全部逻辑
- `style.css` — 配色（浅色/深色两套变量，靠 `body.is-dark` 切换）

完整接口与限制见软件目录下的《插件开发说明.md》。
