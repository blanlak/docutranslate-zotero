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

## 首次使用（其他电脑）
1. 安装 DocuTranslate 本体（提供本地翻译服务），确认 `docutranslate.exe` 可执行
2. 安装本插件，打开 **Zotero 设置 → DocuTranslate 翻译**
3. 点「自动探测本机环境」，或手动填写：
   - **Python 路径**（`pythonw.exe`）
   - **DocuTranslate 程序路径**（`docutranslate.exe`）
   - **DocuTranslate 工作目录**（可选）
   - **服务地址**（本机默认 `http://127.0.0.1:8010`，也可填内网/云端地址）
4. 填写 **API Key / API 地址 / 模型 ID / MinerU Token**
5. 点「测试连接」确认模型 API 与服务都正常，然后右键任意文献条目翻译

> 插件包内**不含任何密钥或个人路径**；配置只保存在本机 Zotero 配置中。
