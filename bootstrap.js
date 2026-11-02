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

// 运行期路径全部动态解析（不留任何个人路径）：优先取设置面板的值，
// 其次自动探测常见安装位置。helperScript 会在每次启动时从插件包解出到
// 用户配置目录，保证与本插件版本一致。
var CONFIG = {
    pythonwExe: "",
    helperScript: "",
    serviceExe: "",
    serviceCwd: "",
    serviceUrl: "http://127.0.0.1:8010",
    edgeCandidates: [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ]
};

var RUNTIME_DIR = "";   // <profile>/docutranslate
var TRACE_FILE = "";    // <profile>/docutranslate/trace.log

function prefGet(name, fallback) {
    try {
        const v = Zotero.Prefs.get("extensions.zotero.docutranslate." + name, true);
        return (v === undefined || v === null || v === "") ? (fallback || "") : v;
    } catch (e) {
        return fallback || "";
    }
}

function pathExistsSync(p) {
    try {
        if (!p) return false;
        if (typeof Zotero.File.pathExists === "function") {
            return Zotero.File.pathExists(p);
        }
        const f = Components.classes["@mozilla.org/file/local;1"]
            .createInstance(Components.interfaces.nsIFile);
        f.initWithPath(p);
        return f.exists();
    } catch (e) {
        return false;
    }
}

// 自动探测 docutranslate 的 conda 环境（pythonw.exe / docutranslate.exe）
// 策略：常见安装位置 -> 各磁盘浅层扫描（envs/docutranslate），避免要求用户手填
function probeEnv(kind) {
    const rel = kind === "pythonw"
        ? "\\envs\\docutranslate\\pythonw.exe"
        : "\\envs\\docutranslate\\Scripts\\docutranslate.exe";
    const userProfile = (function () {
        try {
            return Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
        } catch (e) {
            return "";
        }
    })();
    const bases = [
        userProfile ? userProfile + "\\miniforge3" : "",
        userProfile ? userProfile + "\\miniconda3" : "",
        userProfile ? userProfile + "\\anaconda3" : "",
        "C:\\ProgramData\\miniforge3",
        "C:\\ProgramData\\miniconda3",
        "C:\\ProgramData\\anaconda3"
    ].filter(Boolean);

    for (const b of bases) {
        if (pathExistsSync(b + rel)) return b + rel;
    }

    // 浅层扫描各盘：<root>\<dir>\envs\docutranslate\... 与 <root>\<dir>\<sub>\envs\docutranslate\...
    const drives = ["C:", "D:", "E:", "F:"];
    const skip = ["Windows", "Program Files", "Program Files (x86)", "ProgramData",
        "$Recycle.Bin", "System Volume Information", "Users", "node_modules"];
    for (const d of drives) {
        const root = d + "\\";
        let entries = [];
        try {
            const dir = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            dir.initWithPath(root);
            if (!dir.exists() || !dir.isDirectory()) continue;
            const it = dir.directoryEntries;
            while (it.hasMoreElements()) {
                const sub = it.getNext().QueryInterface(Components.interfaces.nsIFile);
                if (!sub.isDirectory() || skip.indexOf(sub.leafName) >= 0) continue;
                entries.push(sub.path);
            }
        } catch (e) {
            continue;
        }
        // 一级：D:\miniforge3\envs\...
        for (const e of entries) {
            if (pathExistsSync(e + rel)) return e + rel;
        }
        // 二级：D:\devtools\py\miniforge3\envs\...（限制一级子目录数量，避免卡顿）
        for (const e of entries.slice(0, 30)) {
            let subs = [];
            try {
                const dir = Components.classes["@mozilla.org/file/local;1"]
                    .createInstance(Components.interfaces.nsIFile);
                dir.initWithPath(e);
                const it = dir.directoryEntries;
                while (it.hasMoreElements()) {
                    const sub = it.getNext().QueryInterface(Components.interfaces.nsIFile);
                    if (sub.isDirectory()) subs.push(sub.path);
                }
            } catch (e2) {
                continue;
            }
            for (const s of subs.slice(0, 20)) {
                if (pathExistsSync(s + rel)) return s + rel;
                // 三层：D://devtools//py//miniforge3//envs//docutranslate
                let subs3 = [];
                try {
                    const d3 = Components.classes["@mozilla.org/file/local;1"]
                        .createInstance(Components.interfaces.nsIFile);
                    d3.initWithPath(s);
                    const it3 = d3.directoryEntries;
                    while (it3.hasMoreElements()) {
                        const sub3 = it3.getNext().QueryInterface(Components.interfaces.nsIFile);
                        if (sub3.isDirectory()) subs3.push(sub3.path);
                    }
                } catch (e3) { continue; }
                for (const s3 of subs3.slice(0, 15)) {
                    if (pathExistsSync(s3 + rel)) return s3 + rel;
                }
            }
        }
    }

    // 便携版（PyInstaller 单文件，如 DocuTranslate-1.7.10-win.exe）：
    // 名称形如 DocuTranslate*.exe，位置任意（桌面/下载/解压目录）
    if (kind === "docutranslate") {
        const portable = probePortableExe();
        if (portable) return portable;
    }
    return "";
}

// 列出目录下的所有条目（文件 + 目录）
function listEntries(p) {
    const out = [];
    try {
        const d = Components.classes["@mozilla.org/file/local;1"]
            .createInstance(Components.interfaces.nsIFile);
        d.initWithPath(p);
        if (!d.exists() || !d.isDirectory()) return out;
        const it = d.directoryEntries;
        while (it.hasMoreElements()) {
            out.push(it.getNext().QueryInterface(Components.interfaces.nsIFile));
        }
    } catch (e) {}
    return out;
}

// 在单个目录里找便携版可执行文件
function findPortableInDir(dirPath) {
    for (const f of listEntries(dirPath)) {
        try {
            if (!f.isFile()) continue;
            const n = f.leafName.toLowerCase();
            if (n === "dt_helper.exe") continue;   // 本插件自带的助手，排除
            if (n.indexOf("docutranslate") === 0 && n.endsWith(".exe")) {
                return f.path;
            }
        } catch (e) {}
    }
    return "";
}

// 扫描便携版位置：用户桌面/下载/文档 -> 各盘根 -> 各盘一级目录
function probePortableExe() {
    const SKIP = {
        "windows": 1, "program files": 1, "program files (x86)": 1, "programdata": 1,
        "$recycle.bin": 1, "system volume information": 1, "node_modules": 1,
        "appdata": 1, "packages": 1, "drivers": 1, "temp": 1, "tmp": 1,
        "microsoft": 1, "intel": 1, "amd": 1, "nvidia": 1, "perflogs": 1
    };
    const MAX_DIRS = 4000;   // 目录数上限，避免全盘扫描卡死
    const state = { count: 0 };
    const seen = {};

    // 广度优先扫描，depth 为剩余层数
    function scan(root, depth) {
        const queue = [{ p: root, d: 0 }];
        while (queue.length) {
            if (state.count >= MAX_DIRS) return "";
            const cur = queue.shift();
            if (seen[cur.p]) continue;
            seen[cur.p] = 1;
            state.count++;

            const hit = findPortableInDir(cur.p);
            if (hit) return hit;
            if (cur.d >= depth) continue;

            for (const e of listEntries(cur.p)) {
                let isDir = false, name = "";
                try {
                    isDir = e.isDirectory();
                    name = e.leafName;
                } catch (err) { continue; }
                if (!isDir) continue;
                if (name.charAt(0) === ".") continue;
                if (SKIP[name.toLowerCase()]) continue;
                queue.push({ p: e.path, d: cur.d + 1 });
            }
        }
        return "";
    }

    // 1) 常见位置优先（快）
    const quick = [];
    try {
        const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
        quick.push(home + "\\Desktop", home + "\\Downloads", home + "\\Documents");
    } catch (e) {}
    for (const d of ["C:", "D:", "E:", "F:"]) quick.push(d + "\\");
    for (const q of quick) {
        const hit = findPortableInDir(q);
        if (hit) return hit;
    }

    // 2) 用户目录深层扫描（桌面/下载/文档 下 4 层）
    try {
        const home = Services.dirsvc.get("Home", Components.interfaces.nsIFile).path;
        for (const base of [home + "\\Desktop", home + "\\Downloads", home + "\\Documents"]) {
            const hit = scan(base, 4);
            if (hit) return hit;
        }
    } catch (e) {}

    // 3) 各盘浅层深扫（3 层，跳过系统目录）
    for (const d of ["D:", "E:", "F:", "C:"]) {
        const hit = scan(d + "\\", 3);
        if (hit) return hit;
    }
    return "";
}

// 探测 DocuTranslate 本体所在目录（服务启动时的工作目录）
// 判定依据：目录内存在 docutranslate 包或 README_ZH.md 等特征文件
function probeServiceCwd() {
    const drives = ["C:", "D:", "E:", "F:"];
    const looksLikeRepo = (p) =>
        pathExistsSync(p + "\\docutranslate\\app.py") ||
        pathExistsSync(p + "\\docutranslate\\__init__.py") ||
        pathExistsSync(p + "\\README_ZH.md") ||
        pathExistsSync(p + "\\DocuTranslate.ico");

    // 1) 盘根：E:\docutranslate
    for (const d of drives) {
        const c = d + "\\docutranslate";
        if (looksLikeRepo(c)) return c;
    }
    // 2) 一级子目录：D:\devtools\docutranslate / D:\program\docutranslate
    for (const d of drives) {
        let entries = [];
        try {
            const dir = Components.classes["@mozilla.org/file/local;1"]
                .createInstance(Components.interfaces.nsIFile);
            dir.initWithPath(d + "\\");
            if (!dir.exists()) continue;
            const it = dir.directoryEntries;
            while (it.hasMoreElements()) {
                const sub = it.getNext().QueryInterface(Components.interfaces.nsIFile);
                if (sub.isDirectory()) entries.push(sub.path);
            }
        } catch (e) { continue; }
        for (const e of entries.slice(0, 40)) {
            if (looksLikeRepo(e)) return e;
            const c = e + "\\docutranslate";
            if (looksLikeRepo(c)) return c;
        }
    }
    return "";
}

// 探测可用于 HTML→PDF 的浏览器（Edge 优先，其次 Chrome）
function probeEdgePath() {
    const cands = [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
    ];
    for (const c of cands) {
        if (pathExistsSync(c)) return c;
    }
    return "";
}

function log(msg) {
    Zotero.debug("[docutranslate] " + msg);
    try {
        const path = TRACE_FILE || (Zotero.getTempDirectory().path + "\\docutranslate_trace.log");
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

// 拦截主窗口的 openDialog，捕获 ProgressWindow 子窗口引用
function hookOpenDialog() {
    try {
        const main = Zotero.getMainWindow();
        if (!main) return;
        if (main._dtHookedOpenDialog) return;
        main._dtHookedOpenDialog = true;
        const orig = main.openDialog;
        main.openDialog = function () {
            const w = orig.apply(this, Array.prototype.slice.call(arguments));
            const url = arguments[0];
            if (w && typeof url === "string" &&
                url.indexOf("progressWindow.xhtml") >= 0) {
                Translator._lastProgressWindow = w;
            }
            return w;
        };
    } catch (e) {
        log("hookOpenDialog 失败: " + e);
    }
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
                api_key: prefGet("apiKey"),
                base_url: prefGet("baseUrl"),
                model_id: prefGet("modelId"),
                to_lang: prefGet("toLang", "中文"),
                thinking: prefGet("thinking", "disable"),
                mineru_token: prefGet("mineruToken"),
                chunk_size: parseInt(prefGet("chunkSize", "4000"), 10) || 4000,
                concurrent: parseInt(prefGet("concurrent", "10"), 10) || 10,
                // 运行环境（每次翻译时重新读取，改设置后立即生效）
                service_exe: prefGet("serviceExe") || CONFIG.serviceExe,
                service_cwd: prefGet("serviceCwd") || CONFIG.serviceCwd,
                edge_path: prefGet("edgePath")
            };
            await writeUTF8(workDir + "\\config.json", JSON.stringify(cfg));
            log("配置: model=" + cfg.model_id + " base=" + cfg.base_url +
                " service=" + cfg.service_url);

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
                let exePath = "";
                let args = [];
                if (CONFIG.helperExe && fileExistsSync(CONFIG.helperExe)) {
                    // 首选：插件自带的单文件助手，无需 Python 环境
                    exePath = CONFIG.helperExe;
                    args = ["run", pdfPath, workDir, destPdf];
                } else if (CONFIG.pythonwExe && fileExistsSync(CONFIG.pythonwExe) &&
                           CONFIG.helperScript && fileExistsSync(CONFIG.helperScript)) {
                    // 开发者兜底：python + .py
                    exePath = CONFIG.pythonwExe;
                    args = [CONFIG.helperScript, "run", pdfPath, workDir, destPdf];
                } else {
                    throw new Error("助手组件缺失：请重新安装插件（exe 未解包成功）");
                }
                const file = makeNsIFile(exePath);
                const proc = Components.classes["@mozilla.org/process/util;1"]
                    .createInstance(Components.interfaces.nsIProcess);
                proc.init(file);
                log("启动 helper: " + exePath);
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
        const w = Translator._lastProgressWindow;
        if (!w || w.closed) {
            log("无法找到 ProgressWindow 子窗口（openDialog 钩子未触发？）");
            return;
        }
        const doc = w.document;
        const main = Zotero.getMainWindow();
        if (doc && !doc.getElementById("dt-close-x")) {
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
        if (main) {
            try {
                const wW = w.outerWidth || 360;
                const wH = w.outerHeight || 120;
                const x = main.screenX + main.outerWidth - wW - 20;
                const y = main.screenY + main.outerHeight - wH - 20;
                w.moveTo(x, y);
            } catch (e) { log("移动弹窗位置失败: " + e); }
        }
    },

    // 供设置面板“自动探测”调用：返回探测到的本机路径
    probeEnvInfo() {
        try {
            const exe = CONFIG.serviceExe || probeEnv("docutranslate");
            let cwd = CONFIG.serviceCwd || probeServiceCwd();
            // 便携版没有"项目目录"概念，退回 exe 所在目录（仅用于显示/启动上下文）
            if (!cwd && exe) {
                const i = exe.lastIndexOf("\\");
                if (i > 0) cwd = exe.substring(0, i);
            }
            return {
                serviceExe: exe,
                serviceCwd: cwd,
                edgePath: prefGet("edgePath") || probeEdgePath(),
                helperScript: CONFIG.helperScript || ""
            };
        } catch (e) {
            log("probeEnvInfo 失败: " + e);
            return { serviceExe: "", serviceCwd: "", edgePath: "", helperScript: "" };
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

// 运行时初始化：解包助手脚本到用户配置目录，解析并探测所有依赖路径
async function ensureRuntime(rootURI, version) {
    try {
        let profDir = "";
        try {
            profDir = Services.dirsvc.get("ProfD", Components.interfaces.nsIFile).path;
        } catch (e) {}
        RUNTIME_DIR = profDir ? (profDir + "\\docutranslate")
            : (Zotero.getTempDirectory().path + "\\docutranslate");
        Zotero.File.createDirectoryIfMissing(RUNTIME_DIR);
        TRACE_FILE = RUNTIME_DIR + "\\trace.log";
    } catch (e) {}

    // 1) 解包助手：优先单文件 exe（无需 Python 环境），按插件版本判断是否需要更新
    try {
        const exePath = RUNTIME_DIR + "\\dt_helper.exe";
        const verFile = RUNTIME_DIR + "\\helper.version";
        let curVer = "";
        try { curVer = (await IOUtils.readUTF8(verFile)).trim(); } catch (e) {}
        if (curVer !== version || !pathExistsSync(exePath)) {
            const b64 = Zotero.File.getContentsFromURL(rootURI + "helper_b64.txt");
            if (b64 && b64.length > 1000000) {
                const bin = atob(b64.replace(/\s+/g, ""));
                const u8 = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
                await IOUtils.write(exePath, u8);
                await IOUtils.writeUTF8(verFile, version);
                log("已解包助手 exe: " + (u8.length / 1048576).toFixed(1) + " MB");
            }
        }
        if (pathExistsSync(exePath)) CONFIG.helperExe = exePath;
    } catch (e) {
        log("解包助手 exe 失败: " + e);
    }

    // 兜底：开发模式下若没有 exe，解包 .py 并依赖本机 Python
    if (!CONFIG.helperExe) {
        try {
            const helperPath = RUNTIME_DIR + "\\translate_helper.py";
            const content = Zotero.File.getContentsFromURL(rootURI + "translate_helper.py");
            if (content && content.length > 500) {
                await IOUtils.writeUTF8(helperPath, content);
                CONFIG.helperScript = helperPath;
            }
        } catch (e) {
            log("解包助手脚本失败: " + e);
        }
    }

    // 2) 路径：设置面板 > 自动探测（只保留 DocuTranslate 本体与可选的 Edge）
    CONFIG.pythonwExe = prefGet("pythonExe") || probeEnv("pythonw");
    CONFIG.serviceExe = prefGet("serviceExe") || probeEnv("docutranslate");
    CONFIG.serviceCwd = prefGet("serviceCwd");
    const edgePref = prefGet("edgePath");
    if (edgePref) CONFIG.edgeCandidates = [edgePref];

    log("运行环境: " + (CONFIG.helperExe ? "内置 exe" : ("python 兜底 " + CONFIG.helperScript)) +
        " | serviceExe=" + (CONFIG.serviceExe || "(未找到)") +
        " | serviceCwd=" + (CONFIG.serviceCwd || "(默认)"));
}

async function startup({ id, version, rootURI }, reason) {
    try {
        await Zotero.initializationPromise;
        Zotero.DocuTranslate = Translator;
        // 运行时初始化（解包助手 + 解析路径）
        await ensureRuntime(rootURI, version);
        // 迁移旧模型配置到 sensenova-6.8-flash-lite（用户明确要求切换）
        try {
            const cur = Zotero.Prefs.get("extensions.zotero.docutranslate.modelId", true);
            const OLD = ["mimo-v2.5", "mimo-v2.5-pro", "deepseek-v4-flash", "deepseek-v4.1-flash", ""];
            if (!cur || OLD.indexOf(cur) >= 0) {
                Zotero.Prefs.set("extensions.zotero.docutranslate.modelId",
                    "sensenova-6.8-flash-lite", true);
                log("模型已迁移: " + (cur || "(空)") + " -> sensenova-6.8-flash-lite");
            }
        } catch (e) {}
        addMenu(Zotero.getMainWindow());
        // 拦截主窗口 openDialog，捕获 ProgressWindow 子窗口引用（闭包内私有，
        // 外部无法直接拿——必须钩主窗口的 openDialog 才能拿到 chrome window）
        hookOpenDialog();
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
