# DocuTranslate 中文翻译 — Zotero 插件

右键文献条目 → 「翻译为中文 PDF（DocuTranslate）」：调用本机 DocuTranslate 服务解析+翻译 PDF，
译文以「已翻译-论文名.pdf」输出到**原 PDF 同一目录**，并自动挂载到当前条目。

## 文件说明
- `bootstrap.js` / `manifest.json` / `prefs.js` / `prefs.xhtml` / `prefs_load.js` — 插件本体
- `translate_helper.py` — 助手脚本（pythonw 无窗口运行，需 docutranslate conda 环境）
- `chrome/content/icons/` — 图标
- `update.json` — Zotero 自动更新清单
- `DocuTranslate.xpi` — 安装包（发布到 GitHub Releases，Zotero 据此自动更新）

## 自动更新原理
插件 manifest 的 `update_url` 指向本仓库 `update.json`；每次发版：
1. 改 manifest 版本号并重新打包 `DocuTranslate.xpi`
2. 更新 `update.json` 中的 version
3. 推送 → 打 tag → 上传 xpi 到 GitHub Releases
4. Zotero 检查更新 → 发现新版本自动下载安装

## 安装
Zotero → 工具 → 插件 → 齿轮 → Install Plugin From File → 选 DocuTranslate.xpi
（或从 Releases 下载最新版安装）
