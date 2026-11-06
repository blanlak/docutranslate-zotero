// DocuTranslate 设置面板脚本
// 注意：本脚本在面板内容（控件）插入 DOM 之前就执行（Zotero 机制如此），
// 因此必须轮询等待控件出现后再填充与绑定。
(function () {
    const PREFIX = "extensions.zotero.docutranslate.";
    const FIELDS = [
        ["dt-serviceExe", "serviceExe", "string"],
        ["dt-serviceCwd", "serviceCwd", "string"],
        ["dt-edgePath", "edgePath", "string"],
        ["dt-apiKey", "apiKey", "string"],
        ["dt-baseUrl", "baseUrl", "string"],
        ["dt-modelId", "modelId", "string"],
        ["dt-toLang", "toLang", "string"],
        ["dt-mineruToken", "mineruToken", "string"],
        ["dt-chunkSize", "chunkSize", "int"],
        ["dt-concurrent", "concurrent", "int"]
    ];

    // 接口平台快捷选择（地址取自 DocuTranslate 1.7.11 自带列表）
    var PLATFORMS = [
        ["302.AI", "https://api.302.ai/v1"],
        ["MiniMax", "https://api.minimaxi.com/v1"],
        ["OpenAI", "https://api.openai.com/v1"],
        ["Gemini", "https://generativelanguage.googleapis.com/v1beta/openai/"],
        ["DeepSeek", "https://api.deepseek.com/v1"],
        ["MiMo", "https://api.xiaomimimo.com/v1"],
        ["阿里云百炼", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
        ["火山引擎", "https://ark.cn-beijing.volces.com/api/v3"],
        ["硅基流动", "https://api.siliconflow.cn/v1"],
        ["智谱AI", "https://open.bigmodel.cn/api/paas/v4"],
        ["DMXAPI_CN", "https://www.dmxapi.cn/v1"],
        ["DMXAPI_GLOBAL", "https://www.dmxapi.com/v1"],
        ["聚光AI", "https://ai.juguang.chat/v1"],
        ["OpenRouter", "https://openrouter.ai/api/v1"],
        ["LM Studio", "http://127.0.0.1:1234/v1"],
        ["Ollama", "http://127.0.0.1:11434/v1"]
    ];
    var CUSTOM = "__custom__";

    function setupPlatformSelect() {
        var sel = document.getElementById("dt-platform");
        var urlInput = document.getElementById("dt-baseUrl");
        if (!sel || !urlInput) return;

        sel.innerHTML = "";
        var optCustom = document.createElement("option");
        optCustom.value = CUSTOM;
        optCustom.textContent = "自定义接口";
        sel.appendChild(optCustom);
        PLATFORMS.forEach(function (pair) {
            var o = document.createElement("option");
            o.value = pair[1];
            o.textContent = pair[0];
            sel.appendChild(o);
        });

        // 根据当前地址反查平台
        var cur = (urlInput.value || "").trim().toLowerCase().replace(/\/+$/, "");
        var matched = false;
        for (var i = 0; i < PLATFORMS.length; i++) {
            var u = PLATFORMS[i][1].toLowerCase().replace(/\/+$/, "");
            if (u === cur) { sel.value = PLATFORMS[i][1]; matched = true; break; }
        }
        if (!matched) sel.value = CUSTOM;

        sel.addEventListener("change", function () {
            if (sel.value === CUSTOM) {
                urlInput.focus();
                return;
            }
            urlInput.value = sel.value;
            try { Zotero.Prefs.set(PREFIX + "baseUrl", sel.value, true); } catch (e) {}
        });

        urlInput.addEventListener("input", function () {
            var v = (urlInput.value || "").trim().toLowerCase().replace(/\/+$/, "");
            var hit = CUSTOM;
            for (var i = 0; i < PLATFORMS.length; i++) {
                if (PLATFORMS[i][1].toLowerCase().replace(/\/+$/, "") === v) {
                    hit = PLATFORMS[i][1];
                    break;
                }
            }
            sel.value = hit;
        });
    }
    let tries = 0;

    function saveField(id, name, type) {
        const input = document.getElementById(id);
        if (!input) return;
        try {
            let val = input.value;
            if (type === "int") {
                val = parseInt(val, 10) || 0;
                // 并发数上限 3（SenseNova 60 RPM / 128K TPM）
                if (name === "concurrent") {
                    val = Math.max(1, Math.min(val, 32));
                    if (String(val) !== input.value) input.value = val;
                }
            }
            Zotero.Prefs.set(PREFIX + name, val, true);
        } catch (e) {}
    }

    function getPref(name, fallback) {
        try {
            const v = Zotero.Prefs.get(PREFIX + name, true);
            return (v === undefined || v === null) ? fallback : v;
        } catch (e) {
            return fallback;
        }
    }

    function setResult(ok, text, detail) {
        const span = document.getElementById("dt-test-result");
        if (span) {
            span.textContent = text;
            span.style.color = ok ? "#1a7f37" : "#c62828";
            span.style.fontWeight = "600";
        }
        const d = document.getElementById("dt-test-detail");
        if (d) d.innerHTML = detail || "";
    }

    function saveAll() {
        for (let [id, name, type] of FIELDS) saveField(id, name, type);
    }

    // 自动探测本机环境（路径由插件侧探测，这里只负责回填）
    function probe() {
        const out = document.getElementById("dt-probe-result");
        if (out) {
            out.textContent = "扫描中，请稍候…";
            out.style.color = "#666";
        }
        // 深层扫描可能耗时 1-3 秒，先让界面刷新出提示再执行
        setTimeout(function () { probeRun(); }, 50);
    }

    function probeRun() {
        const out = document.getElementById("dt-probe-result");
        try {
            const info = (Zotero.DocuTranslate && Zotero.DocuTranslate.probeEnvInfo)
                ? Zotero.DocuTranslate.probeEnvInfo() : null;
            if (!info) {
                if (out) out.textContent = "探测不可用";
                return;
            }
            const map = [
                ["dt-serviceExe", "serviceExe", info.serviceExe],
                ["dt-serviceCwd", "serviceCwd", info.serviceCwd],
                ["dt-edgePath", "edgePath", info.edgePath]
            ];
            let found = 0;
            for (const [id, name, val] of map) {
                const input = document.getElementById(id);
                if (input && val) {
                    input.value = val;
                    try { Zotero.Prefs.set(PREFIX + name, val, true); } catch (e) {}
                    found++;
                }
            }
            if (out) {
                out.textContent = found
                    ? "已填入 " + found + " 项（可手动修改）"
                    : "未探测到，请手动填写";
                out.style.color = found ? "#1a7f37" : "#c62828";
            }
        } catch (e) {
            if (out) out.textContent = "探测失败：" + (e.message || e);
        }
    }

    async function testApi() {
        const btn = document.getElementById("dt-test");
        saveAll();

        const key = (getPref("apiKey", "") || "").trim();
        const base = (getPref("baseUrl", "") || "").trim().replace(/\/+$/, "");
        const model = (getPref("modelId", "") || "").trim();
        const svc = "http://127.0.0.1:8010";  // 仅本地服务

        if (!base) {
            setResult(false, "✗ 请先填写 API 地址");
            return;
        }
        if (!model) {
            setResult(false, "✗ 请先填写模型 ID");
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.textContent = "测试中…";
        }
        setResult(false, "测试中…", "");

        let apiLine = "";
        let apiOk = false;
        try {
            const t0 = Date.now();
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            const resp = await fetch(base + "/chat/completions", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + key
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: "user", content: "ping" }],
                    max_tokens: 16
                }),
                signal: ctrl.signal
            });
            clearTimeout(timer);
            const ms = Date.now() - t0;
            const txt = await resp.text();
            if (resp.ok) {
                apiOk = true;
                let modelEcho = "";
                try { modelEcho = (JSON.parse(txt).model || ""); } catch (e) {}
                apiLine = "模型 API：✓ 连接成功（" + ms + "ms" +
                    (modelEcho ? "，返回模型 " + modelEcho : "") + "）";
            } else {
                apiLine = "模型 API：✗ HTTP " + resp.status + " — " +
                    txt.replace(/\s+/g, " ").slice(0, 160);
            }
        } catch (e) {
            apiLine = "模型 API：✗ 请求失败 — " +
                ((e && (e.name === "AbortError" ? "超时（20 秒）" : e.message)) || e);
        }

        // 顺带检查 DocuTranslate 服务（地址可在“运行环境”里改）
        let localLine = "";
        try {
            const ctrl2 = new AbortController();
            const t2 = setTimeout(() => ctrl2.abort(), 5000);
            const r2 = await fetch(svc + "/service/meta", { signal: ctrl2.signal });
            clearTimeout(t2);
            localLine = r2.ok
                ? "DocuTranslate 服务：✓ 运行中（" + svc + "）"
                : "DocuTranslate 服务：✗ 响应异常 HTTP " + r2.status;
        } catch (e) {
            localLine = "DocuTranslate 服务：✗ 未启动（翻译时会自动拉起）";
        }

        setResult(apiOk, apiOk ? "✓ 可用" : "✗ 不可用",
            '<div>' + apiLine + '</div><div>' + localLine + '</div>');

        if (btn) {
            btn.disabled = false;
            btn.textContent = "测试连接";
        }
    }

    function bind() {
        let el = document.getElementById("dt-apiKey");
        if (!el) {
            if (++tries < 100) {
                setTimeout(bind, 50);
            }
            return;
        }
        for (let [id, name, type] of FIELDS) {
            const input = document.getElementById(id);
            if (!input) continue;
            try {
                const v = Zotero.Prefs.get(PREFIX + name, true);
                if (v !== undefined && v !== null && v !== "") {
                    input.value = v;
                }
            } catch (e) {}
            input.addEventListener("change", function () {
                saveField(id, name, type);
            });
        }
        const btn = document.getElementById("dt-test");
        if (btn) {
            btn.addEventListener("click", function (e) {
                e.preventDefault();
                testApi();
            });
        }
        // 保存按钮：写入所有字段并给出明确反馈
        const saveBtn = document.getElementById("dt-save");
        if (saveBtn) {
            let saveTimer = null;
            saveBtn.addEventListener("click", function (e) {
                e.preventDefault();
                saveAll();
                const apiKey = (getPref("apiKey", "") || "").trim();
                const mineru = (getPref("mineruToken", "") || "").trim();
                const svcExe = (getPref("serviceExe", "") || "").trim();
                const missing = [];
                if (!apiKey) missing.push("API Key");
                if (!mineru) missing.push("MinerU Token");
                if (!svcExe) missing.push("DocuTranslate 程序路径");

                const out = document.getElementById("dt-save-result");
                if (!out) return;
                const hasCn = /[^\x00-\x7F]/.test(svcExe) ||
                              /[^\x00-\x7F]/.test((getPref("serviceCwd", "") || ""));
                if (missing.length) {
                    out.textContent = "✓ 已保存，但还缺：" + missing.join("、");
                    out.style.color = "#b26a00";
                } else if (hasCn) {
                    out.textContent = "✓ 已保存（路径含中文，已自动兼容；建议移到英文目录更稳妥）";
                    out.style.color = "#b26a00";
                } else {
                    out.textContent = "✓ 已保存，配置已生效";
                    out.style.color = "#1a7f37";
                }
                out.style.fontWeight = "600";
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = setTimeout(function () {
                    if (out) out.textContent = "";
                }, 6000);
            });
        }

        const probeBtn = document.getElementById("dt-probe");
        if (probeBtn) {
            probeBtn.addEventListener("click", function (e) {
                e.preventDefault();
                probe();
            });
        }
        // 注册/获取 Key 的外链（用系统默认浏览器打开）
        const links = [
            ["dt-link-mineru", "https://mineru.net/apiManage/token"],
            ["dt-download",
             "https://github.com/blanlak/docutranslate-zotero/releases/download/v2.1.26/DocuTranslate-1.7.11-win.exe"]
        ];
        for (const [id, url] of links) {
            const btn = document.getElementById(id);
            if (!btn) continue;
            btn.addEventListener("click", function (e) {
                e.preventDefault();
                try {
                    if (Zotero.launchURL) Zotero.launchURL(url);
                    else Services.io; // 兜底不处理
                } catch (err) {}
            });
        }

        // 字段已回填，最后再初始化平台下拉（需要读取当前 API 地址做反查）
        setupPlatformSelect();
    }

    bind();
})();