// DocuTranslate 设置面板脚本
// 注意：本脚本在面板内容（控件）插入 DOM 之前就执行（Zotero 机制如此），
// 因此必须轮询等待控件出现后再填充与绑定。
(function () {
    const PREFIX = "extensions.zotero.docutranslate.";
    const FIELDS = [
        ["dt-apiKey", "apiKey", "string"],
        ["dt-baseUrl", "baseUrl", "string"],
        ["dt-modelId", "modelId", "string"],
        ["dt-toLang", "toLang", "string"],
        ["dt-thinking", "thinking", "string"],
        ["dt-mineruToken", "mineruToken", "string"],
        ["dt-chunkSize", "chunkSize", "int"],
        ["dt-concurrent", "concurrent", "int"]
    ];
    let tries = 0;

    function saveField(id, name, type) {
        const input = document.getElementById(id);
        if (!input) return;
        try {
            let val = input.value;
            if (type === "int") val = parseInt(val, 10) || 0;
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

    async function testApi() {
        const btn = document.getElementById("dt-test");
        // 先把当前输入框的值落盘（避免用户粘贴后未失焦导致读到旧值）
        for (let [id, name, type] of FIELDS) saveField(id, name, type);

        const key = (getPref("apiKey", "") || "").trim();
        const base = (getPref("baseUrl", "") || "").trim().replace(/\/+$/, "");
        const model = (getPref("modelId", "") || "").trim();

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

        const url = base + "/chat/completions";
        const t0 = Date.now();
        let apiLine = "";
        let apiOk = false;
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 20000);
            const resp = await fetch(url, {
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

        // 顺带检查本地翻译服务
        let localLine = "";
        try {
            const ctrl2 = new AbortController();
            const t2 = setTimeout(() => ctrl2.abort(), 4000);
            const r2 = await fetch("http://127.0.0.1:8010/service/meta", { signal: ctrl2.signal });
            clearTimeout(t2);
            localLine = r2.ok
                ? "本地翻译服务：✓ 运行中（127.0.0.1:8010）"
                : "本地翻译服务：✗ 响应异常 HTTP " + r2.status;
        } catch (e) {
            localLine = "本地翻译服务：✗ 未启动（右键翻译时会自动拉起）";
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
    }

    bind();
})();
