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

    function bind() {
        let el = document.getElementById("dt-apiKey");
        if (!el) {
            // 控件还没插入，稍后再试（最多约 5 秒）
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
                try {
                    let val = input.value;
                    if (type === "int") {
                        val = parseInt(val, 10) || 0;
                    }
                    Zotero.Prefs.set(PREFIX + name, val, true);
                } catch (e) {}
            });
        }
    }

    bind();
})();
