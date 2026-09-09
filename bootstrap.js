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

// ---- 同步文件工具（事件驱动编排用，绝不依赖 promise 定时器） ----

function makeNsIFile(p) {
    const f = Components.classes["@mozilla.org/file/local;1"]
        .createInstance(Components.interfaces.nsIFile);
    f.initWithPath(p);
    return f;
}

function fileExistsSync(p) {
    try { return makeNsIFile(p).exists(); } catch (e) { return false; }
}

// 同步读取整个文件并解码为 UTF-8 字符串（不存在/为空返回 ""）
function syncReadUtf8(p) {
    try {
        const f = makeNsIFile(p);
        if (!f.exists()) return "";
        const is = Components.classes["@mozilla.org/network/file-input-stream;1"]
            .createInstance(Components.interfaces.nsIFileInputStream);
        is.init(f, -1, 0, 0);
        const avail = is.available();
        if (!avail) { is.close(); return ""; }
        const bis = Components.classes["@mozilla.org/binaryinputstream;1"]
            .createInstance(Components.interfaces.nsIBinaryInputStream);
        bis.setInputStream(is);
        const bytes = bis.readByteArray(avail);
        bis.close();
        is.close();
        return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
    } catch (e) { return ""; }
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
        // 翻译过程中弹窗持续显示；点窗口身体不会关闭（只有右上角 × 或自动超时）
        const pw = new Zotero.ProgressWindow({ closeOnClick: false });
        this._pw = pw;
        pw.changeHeadline("DocuTranslate 翻译");
        const progress = new pw.ItemProgress(
            "chrome://zotero/skin/treeitem-pdf.png",
            "准备翻译：" + title
        );
        pw.show();
        // 等窗口加载完成后再注入 × + 移动到主窗口右下角内偏移
        this.injectCloseXAndPosition();

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

            // 3. 事件驱动编排：启动 helper（进程退出时 observer 同步触发挂载），
            //    nsITimer 每秒同步读进度文件刷新弹窗——全程无 await 轮询
            progress.setText("检查本地翻译服务…");
            log("流程开始: " + title + " | PDF: " + pdfPath);
            const safeName = "已翻译-" + title.replace(/[\\/:*?"<>|]/g, "_") + ".pdf";
            // 译文 PDF 的目标位置：与原 PDF 同一目录（用户核心需求）
            const pdfDir = pdfPath.substring(0, pdfPath.lastIndexOf("\\"));
            const destPdf = pdfDir + "\\" + safeName;
            log("译文目标: " + destPdf);
            const ok = await this.runTranslateAndMount(
                pdfPath, workDir, destPdf, safeName, title, item.id, progress);
            if (!ok) {
                // 失败详情已由 runTranslateAndMount 展示在弹窗
                log("翻译流程未完成，详情见弹窗");
                return;
            }
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

    // ============ 事件驱动编排（v1.4.3 核心） ============
    // 启动一次 helper（pythonw，无窗口）；helper 进程退出时由 nsIProcess
    // observer（同步 XPCOM 事件，不依赖 promise 定时器）触发挂载；
    // 期间 nsITimer 每秒同步读 progress.txt 刷新弹窗。
    // 返回 Promise，resolve(true) = helper 完成且译文已挂载；resolve(false)=失败。
    runTranslateAndMount(pdfPath, workDir, destPdf, safeName, title, parentItemID, progress) {
        return new Promise((resolveOuter) => {
            const progressFile = workDir + "\\progress.txt";
            let timer = null;
            let settled = false;

            const settle = (ok) => {
                if (settled) return;
                settled = true;
                try { timer.cancel(); } catch (e) {}
                resolveOuter(ok);
            };

            const mount = async () => {
                try {
                    // 读取最终进度，判断是否失败
                    const raw = syncReadUtf8(progressFile).trim();
                    if (raw.startsWith("-1")) {
                        throw new Error(raw.slice(3) || "翻译失败");
                    }
                    if (!fileExistsSync(destPdf)) {
                        throw new Error("未在原 PDF 目录找到译文: " + destPdf);
                    }
                    progress.setText("关联到 Zotero 条目…");
                    await Zotero.Attachments.linkFromFile({
                        file: makeNsIFile(destPdf),
                        parentItemID: parentItemID,
                        title: "已翻译-" + title
                    });
                    log("已挂载: " + destPdf);
                    progress.setProgress(100);
                    progress.setText("翻译完成：" + safeName);
                    if (Translator._pw) Translator._pw.startCloseTimer(30000);
                    settle(true);
                } catch (e) {
                    log("挂载失败: " + (e.stack || e));
                    try {
                        progress.setError();
                        progress.setText("失败：" + (e.message || e));
                        if (Translator._pw) Translator._pw.startCloseTimer(30000);
                    } catch (e2) {}
                    settle(false);
                }
            };

            // 进度刷新 timer：每秒同步读一次 progress.txt
            const tick = () => {
                const raw = syncReadUtf8(progressFile).trim();
                if (!raw) return;
                const sp = raw.indexOf(" ");
                if (sp <= 0) return;
                const pct = parseInt(raw.slice(0, sp), 10);
                if (isNaN(pct)) return;
                try {
                    progress.setProgress(Math.max(1, Math.min(99, pct)));
                    progress.setText(raw.slice(sp + 1));
                } catch (e) {}
            };

            // helper 进程退出（成功或失败都会退出）→ 触发挂载
            const observer = {
                observe(subject, topic, data) {
                    if (topic === "process-finished" || topic === "process-failed") {
                        log("helper 进程退出: " + topic);
                        mount();
                    }
                }
            };

            // 启动一次进程（唯一一次 nsIProcess 调用）
            try {
                if (!fileExistsSync(CONFIG.pythonwExe)) {
                    throw new Error("pythonw 不存在: " + CONFIG.pythonwExe);
                }
                const file = makeNsIFile(CONFIG.pythonwExe);
                const proc = Components.classes["@mozilla.org/process/util;1"]
                    .createInstance(Components.interfaces.nsIProcess);
                proc.init(file);
                const args = [CONFIG.helperScript, "run", pdfPath, workDir, destPdf];
                log("启动 helper: " + args.join(" "));
                proc.runwAsync(args, args.length, observer);
            } catch (e) {
                log("启动 helper 异常: " + (e.stack || e));
                try {
                    progress.setError();
                    progress.setText("失败：" + (e.message || e));
                } catch (e2) {}
                settle(false);
                return;
            }

            timer = Components.classes["@mozilla.org/timer;1"]
                .createInstance(Components.interfaces.nsITimer);
            timer.initWithCallback({ notify: tick }, 1000,
                Components.interfaces.nsITimer.TYPE_REPEATING_SLACK);

            // 兜底：25 分钟无进程退出则失败
            const guard = Components.classes["@mozilla.org/timer;1"]
                .createInstance(Components.interfaces.nsITimer);
            guard.initWithCallback({
                notify() {
                    log("翻译 25 分钟未完成，中止");
                    try { progress.setError(); progress.setText("失败：处理超时"); } catch (e) {}
                    settle(false);
                }
            }, 25 * 60 * 1000, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
        });
    },

    // 给所有 DocuTranslate 进度弹窗注入右上角 ×（Zotero 弹窗默认无此按钮），
    // 并移动到主窗口右下角内偏移
    injectCloseXAndPosition() {
        const self = this;
        const timer = Components.classes["@mozilla.org/timer;1"]
            .createInstance(Components.interfaces.nsITimer);
        timer.initWithCallback({
            notify() {
                try { self._injectAndPositionPopup(); }
                catch (e) { log("注入/定位失败: " + e); }
            }
        }, 250, Components.interfaces.nsITimer.TYPE_ONE_SHOT);
    },

    _injectAndPositionPopup() {
        const wm = Components.classes["@mozilla.org/appshell/window-mediator;1"]
            .getService(Components.interfaces.nsIWindowMediator);
        const wins = wm.getEnumerator(null);
        const main = Zotero.getMainWindow();
        while (wins.hasMoreElements()) {
            const w = wins.getNext();
            const doc = w && w.document;
            if (!doc) continue;
            if ((doc.documentURI || "").indexOf("progressWindow.xhtml") === -1) continue;
            // 注入 ×
            if (!doc.getElementById("dt-close-x")) {
                try {
                    const x = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
                    x.id = "dt-close-x";
                    x.textContent = "×";
                    x.title = "关闭";
                    x.style.cssText = "position:absolute;top:0;right:4px;z-index:2147483647;" +
                        "border:none;background:transparent;color:#c00;font-size:18px;" +
                        "font-weight:bold;cursor:pointer;line-height:1;padding:3px 7px;font-family:Arial,sans-serif;";
                    x.addEventListener("click", function () {
                        try { w.close(); } catch (e) {}
                    });
                    doc.body.appendChild(x);
                } catch (e) { log("注入 × 元素失败: " + e); }
            }
            // 移动到主窗口右下角内偏移 20px
            if (main) {
                try {
                    const wW = w.outerWidth || 360;
                    const wH = w.outerHeight || 120;
                    const x = main.screenX + main.outerWidth - wW - 20;
                    const y = main.screenY + main.outerHeight - wH - 20;
                    w.moveTo(x, y);
                } catch (e) { log("移动弹窗位置失败: " + e); }
            }
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
