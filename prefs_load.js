// DocuTranslate 设置面板脚本：读 Zotero.Prefs 填充输入框，修改自动写回
(function () {
    const PREFIX = "extensions.zotero.docutranslate.";
    const FIELDS = [
        ["dt-apiKey", "apiKey"],
        ["dt-baseUrl", "baseUrl"],
        ["dt-modelId", "modelId"],
        ["dt-toLang", "toLang"],
        ["dt-thinking", "thinking"],
        ["dt-mineruToken", "mineruToken"],
        ["dt-chunkSize", "chunkSize"],
        ["dt-concurrent", "concurrent"]
    ];

    function init() {
        for (let [id, name] of FIELDS) {
            const el = document.getElementById(id);
            if (!el) continue;
            try {
                const v = Zotero.Prefs.get(PREFIX + name, true);
                if (v !== undefined && v !== null && v !== "") {
                    el.value = v;
                }
            } catch (e) {}
            el.addEventListener("change", function () {
                try {
                    let val = el.value;
                    if (name === "chunkSize" || name === "concurrent") {
                        val = parseInt(val, 10) || 0;
                    }
                    Zotero.Prefs.set(PREFIX + name, val, true);
                } catch (e) {}
            });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
