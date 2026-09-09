/**
 * DocuTranslate 中文翻译 — Zotero 7/10 插件 (v1.1.0)
 *
 * 流程：右键条目 -> 启动本机 Python 助手脚本（上传 PDF 到 DocuTranslate 服务并翻译，
 * 进度写入进度文件）-> 插件读进度文件刷新弹窗 -> Edge 无头打印 HTML 为 PDF ->
 * 以「已翻译-论文名.pdf」自动导入回条目。
 *
 * 设计说明：不使用插件内 HTTP（Zotero 10 中 POST 响应不可靠），与服务的全部通信
 * 由助手脚本完成，插件只读本地进度文件。
 *
 * 对外接口：Zotero.DocuTranslate.translateSelected(items?)
 */

if (typeof Zotero === "undefined") {
    var Zotero;
}

var MENU_ID = "docutranslate-itemmenu";

var CONFIG = {
    pythonwExe: "D:\\devtools\\py\\miniforge\\envs\\docutranslate\\pythonw.exe",
    helperScript: "E:\\zotero-docutranslate\\translate_helper.py",
    serviceExe: "D:\\devtools\\py\\miniforge\\envs\\docutranslate\\Scripts\\docutranslate.exe",
    edgeCandidates: [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ]
};

function log(msg) {
    Zotero.debug("[docutranslate] " + msg);
    try {
        const path = "E:\\zotero-docutranslate\\zotero_plugin_trace.log";
        const line = new Date().toISOString() + " " + msg + "\n";
        // IOUtils 的 append 选项不可靠（多次调用互相覆盖），改读-合并-写
        IOUtils.readUTF8(path)
            .then(old => IOUtils.writeUTF8(path, old + line))
            .catch(() => IOUtils.writeUTF8(path, line))
            .catch(e => {});
    } catch (e) {}
}

function delay(ms) {
    // 用 XPCOM nsITimer 实现（不依赖 shim 的 setTimeout / Zotero.Promise.delay，
    // 两者在 Zotero 10 插件沙箱中均不可靠）
    return new Promise(resolve => {
        const timer = Components.classes["@mozilla.org/timer;1"]
            .createInstance(Components.interfaces.nsITimer);
        timer.initWithCallback({ notify: resolve }, ms,
            Components.interfaces.nsITimer.TYPE_ONE_SHOT);
    });
}

// Zotero 10 兼容：文件操作全部走 IOUtils
async function fileExists(p) {
    try { await IOUtils.stat(p); return true; } catch (e) { return false; }
}

async function writeUTF8(p, text) {
    await IOUtils.writeUTF8(p, text);
}

async function removeDirRecursive(p) {
    try { await IOUtils.remove(p, { recursive: true }); } catch (e) {}
}

var Translator = {

    async translateSelected(items) {
        if (!items || !items.length) {
            const win = Zotero.getMainWindow();
            items = win.ZoteroPane.getSelectedItems();
        }
        items = (items || []).filter(i => i.isRegularItem && i.isRegularItem());
        if (!items.length) {
            this.notify("请先选中要翻译的文献条目", true);
            return;
        }
        for (let item of items) {
            try {
                await this.translateItem(item);
            } catch (e) {
                log("翻译失败: " + e);
            }
        }
    },

    async translateItem(item) {
        const title = item.getField("title") || "未命名文献";
        if (this._pw) {
            try { this._pw.close(); } catch (e) {}
        }
        const pw = new Zotero.ProgressWindow({ closeOnClick: true });
        this._pw = pw;
        pw.changeHeadline("DocuTranslate 翻译");
        const progress = new pw.ItemProgress(
            "chrome://zotero/skin/treeitem-pdf.png",
            "准备翻译：" + title
        );
        pw.show();

        let workDir = null;
        try {
            // 1. 找到条目下最合适的 PDF 附件
            progress.setText("查找 PDF 附件…");
            const att = await item.getBestAttachment();
            if (!att) throw new Error("该条目下没有 PDF 附件");
            const pdfPath = await att.getFilePathAsync();
            if (!pdfPath || !pdfPath.toLowerCase().endsWith(".pdf")) {
                throw new Error("未找到 PDF 文件");
            }
            log("源 PDF: " + pdfPath);

            // 2. 准备工作目录 + 从 Zotero 设置读取配置写入 config.json
            workDir = Zotero.getTempDirectory().path + "\\docutranslate_" + Date.now();
            Zotero.File.createDirectoryIfMissing(workDir);
            const P = "extensions.zotero.docutranslate.";
            const cfg = {
                api_key: Zotero.Prefs.get(P + "apiKey", true) || "",
                base_url: Zotero.Prefs.get(P + "baseUrl", true) || "",
                model_id: Zotero.Prefs.get(P + "modelId", true) || "",
                to_lang: Zotero.Prefs.get(P + "toLang", true) || "中文",
                thinking: Zotero.Prefs.get(P + "thinking", true) || "disable",
                mineru_token: Zotero.Prefs.get(P + "mineruToken", true) || "",
                chunk_size: parseInt(Zotero.Prefs.get(P + "chunkSize", true), 10) || 4000,
                concurrent: parseInt(Zotero.Prefs.get(P + "concurrent", true), 10) || 10
            };
            await writeUTF8(workDir + "\\config.json", JSON.stringify(cfg));
            log("配置: model=" + cfg.model_id + " base=" + cfg.base_url);

            // 3. 单次助手调用完成全部流程：检查/拉起服务 -> 上传翻译 -> 下载译文
            //    -> Edge 打印 -> 复制译文 PDF 到原 PDF 同目录
            //    （插件只发起一次进程启动，之后的进度全部来自 progress.txt）
            progress.setText("检查本地翻译服务…");
            log("流程开始: " + title + " | PDF: " + pdfPath);
            const safeName = "已翻译-" + title.replace(/[\\/:*?"<>|]/g, "_") + ".pdf";
            // 译文 PDF 的目标位置：与原 PDF 同一目录（用户核心需求）
            const pdfDir = pdfPath.substring(0, pdfPath.lastIndexOf("\\"));
            const destPdf = pdfDir + "\\" + safeName;
            log("译文目标: " + destPdf);
            const translated = await this.runHelper("run", pdfPath, workDir, progress, destPdf);
            if (!translated) throw new Error("翻译流程未完成");

            // 4. 确认译文 PDF 已在原 PDF 同目录生成
            if (!(await fileExists(destPdf))) {
                throw new Error("未在原 PDF 目录找到译文: " + destPdf);
            }

            // 5. 以链接方式挂到条目（官方 linkFromFile：自动处理路径与父级关联，
            //    文件保留在原 PDF 目录不复制）
            progress.setText("关联到 Zotero 条目…");
            const linkFile = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            linkFile.initWithPath(destPdf);
            await Zotero.Attachments.linkFromFile({
                file: linkFile,
                parentItemID: item.id,
                title: "已翻译-" + title
            });
            log("已关联: " + destPdf);

            progress.setIcon("chrome://zotero/skin/tick.png");
            progress.setText("翻译完成：" + safeName);
            pw.startCloseTimer(6000);
            log("完成: " + safeName);
        } catch (e) {
            progress.setError();
            progress.setText("失败：" + (e.message || e));
            pw.startCloseTimer(10000);
            log("失败: " + (e.stack || e));
        } finally {
            setTimeout(async () => {
                try { pw.close(); } catch (e) {}
                if (workDir) {
                    await removeDirRecursive(workDir);
                }
            }, 15 * 60 * 1000);
        }
    },

    // 单次助手调用（run 模式）：插件只发起这一次进程启动，随后轮询 progress.txt
    // 直到完成标记(>=100)或失败标记(-1，抛出具体错误)
    async runHelper(mode, pdfPath, workDir, progress, destPdf) {
        const progressFile = workDir + "\\progress.txt";
        log("runHelper " + mode + " 启动, workDir=" + workDir);
        // 清除旧的进度文件
        try { await IOUtils.remove(progressFile); } catch (e) { log("remove progress 失败: " + e); }
        try {
            const args = [CONFIG.helperScript, "run", pdfPath, workDir];
            if (destPdf) args.push(destPdf);
            await this.runAsync(CONFIG.pythonwExe, args);
        } catch (e) {
            log("runAsync 抛异常: " + (e.stack || e));
            throw e;
        }

        const decoder = new TextDecoder("utf-8");
        let lastRaw = "", lastChange = Date.now();
        const maxMs = 20 * 60 * 1000;
        const start = Date.now();
        while (Date.now() - start < maxMs) {
            await delay(1200);
            let raw = "";
            try {
                const buf = await IOUtils.read(progressFile);
                raw = decoder.decode(buf).trim();
            } catch (e) { continue; }
            if (raw && raw !== lastRaw) {
                lastRaw = raw;
                lastChange = Date.now();
                const sp = raw.indexOf(" ");
                const pct = parseInt(raw.slice(0, sp), 10);
                const msg = raw.slice(sp + 1);
                if (pct === -1) throw new Error(msg);  // 明确失败
                progress.setProgress(Math.max(1, Math.min(99, pct)));
                progress.setText(msg);
                if (pct >= 100) return true;
            }
            // 5 分钟无进展视为卡死
            if (Date.now() - lastChange > 5 * 60 * 1000) {
                throw new Error("翻译长时间无进展，已中止");
            }
        }
        throw new Error("处理超时");
    },

    async runAsync(exePath, args) {
        log("runAsync: " + exePath + " " + args.join(" "));
        try {
            if (!(await fileExists(exePath))) {
                throw new Error("文件不存在: " + exePath);
            }
            // 直接构造 nsIFile（Zotero 10 的 pathToFile 返回值没有 exists 方法）
            const file = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            file.initWithPath(exePath);
            const proc = Components.classes["@mozilla.org/process/util;1"]
                .createInstance(Components.interfaces.nsIProcess);
            proc.init(file);
            proc.runwAsync(args, args.length);
            log("runAsync 已发出");
            return proc;
        } catch (e) {
            log("runAsync 异常: " + (e.stack || e));
            throw e;
        }
    },

    notify(msg, isError) {
        const pw = new Zotero.ProgressWindow();
        pw.changeHeadline("DocuTranslate 翻译");
        pw.addDescription(msg);
        pw.show(!isError);
        pw.startCloseTimer(5000);
    }
};

function addMenu(win) {
    if (!win || !win.document) return;
    const doc = win.document;
    if (doc.getElementById(MENU_ID)) return;
    const menu = doc.getElementById("zotero-itemmenu");
    if (!menu) return;
    const item = doc.createXULElement("menuitem");
    item.id = MENU_ID;
    item.className = "menuitem-iconic";
    item.label = "翻译为中文 PDF（DocuTranslate）";
    item.addEventListener("command", function () {
        Zotero.DocuTranslate.translateSelected();
    });
    menu.appendChild(item);
    log("菜单已注册");
}

function removeMenu(win) {
    if (!win || !win.document) return;
    const el = win.document.getElementById(MENU_ID);
    if (el) el.remove();
}

async function startup({ id, version, rootURI }, reason) {
    try {
        await Zotero.initializationPromise;
        Zotero.DocuTranslate = Translator;
        addMenu(Zotero.getMainWindow());
        // 注册设置面板（Zotero 设置左侧栏 -> DocuTranslate 翻译）
        Zotero.PreferencePanes.register({
            pluginID: "docutranslate-cn@blanklan",
            label: "DocuTranslate 翻译",
            image: rootURI + "chrome/content/icons/icon.png",
            src: rootURI + "prefs.xhtml",
            scripts: [rootURI + "prefs_load.js"]
        });
        log("插件已启动 v" + version);
    } catch (e) {
        // 绝不让启动异常导致插件被移除
        try {
            Zotero.logError(e);
        } catch (e2) {}
        dump("[docutranslate] startup error: " + e + "\n");
    }
}

function shutdown({ id }, reason) {
    removeMenu(Zotero.getMainWindow());
    if (Zotero.DocuTranslate) delete Zotero.DocuTranslate;
}

function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) {
    try {
        addMenu(window);
    } catch (e) {
        dump("[docutranslate] onMainWindowLoad error: " + e + "\n");
    }
}
