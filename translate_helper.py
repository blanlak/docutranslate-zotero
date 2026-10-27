# -*- coding: utf-8 -*-
"""DocuTranslate Zotero 插件助手 v3
用法: python translate_helper.py run <input_pdf> <work_dir>
一次调用完成全部流程（插件只发起这一次进程启动）:
  1. 检查本地 DocuTranslate 服务；未启动则拉起（独立控制台+脱离作业）并等待就绪
  2. 上传 PDF -> 轮询翻译进度 -> 下载译文 HTML 到 work_dir/translated.html
进度文件: work_dir/progress.txt，格式 "<百分比> <消息>"；-1 失败
"""
import json
import pathlib
import subprocess
import sys
import time

import httpx

SERVICE = "http://127.0.0.1:8010"
SERVICE_EXE = r"D:\devtools\py\miniforge\envs\docutranslate\Scripts\docutranslate.exe"
SERVICE_CWD = r"E:\docutranslate"
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]

PAYLOAD = {
    "workflow_type": "markdown_based",
    "convert_engine": "mineru",
    "model_version": "vlm",
    "formula_ocr": True,
    "base_url": "https://token.sensenova.cn/v1",
    "api_key": "sk-ccctebmk1hwbzol4l8w3rlft9trlbhioit64df24swgti6od",
    "model_id": "sensenova-6.8-flash-lite",
    "to_lang": "中文",
    "thinking": "disable",
    "chunk_size": 4000,
    "concurrent": 10,
    "temperature": 0.3,
    "timeout": 600,
    "retry": 3,
    "mineru_token": "sk-DlsOFrSxSDFSQw4qv1BAWHKJxnXT9zVaxQuxWrEHlT9InpRK",
}


def setp(pct, msg):
    (work / "progress.txt").write_text("{} {}".format(pct, msg), encoding="utf-8")


def service_up():
    try:
        client.get(SERVICE + "/service/meta")
        return True
    except Exception:
        return False


def ensure_service():
    """检查服务；未启动则拉起并等待就绪。返回 True/False"""
    if service_up():
        time.sleep(1)
        if service_up():
            return True

    setp(4, "服务未启动，正在拉起（约需 10 秒）…")
    # CREATE_NEW_CONSOLE = 独立控制台；CREATE_BREAKAWAY_FROM_JOB = 脱离父作业对象
    try:
        subprocess.Popen([SERVICE_EXE, "-i"], cwd=SERVICE_CWD,
                         creationflags=subprocess.CREATE_NEW_CONSOLE | 0x01000000)
    except Exception:
        try:
            subprocess.Popen([SERVICE_EXE, "-i"], cwd=SERVICE_CWD,
                             creationflags=subprocess.CREATE_NEW_CONSOLE)
        except Exception as e:
            setp(-1, "拉起翻译服务失败: {}".format(e))
            return False

    for _ in range(45):
        time.sleep(2)
        setp(4, "等待翻译服务就绪…")
        if service_up():
            time.sleep(1)
            if service_up():
                return True
    setp(-1, "翻译服务启动超时，请手动运行 启动翻译界面.bat 后重试")
    return False


def translate(pdf, dest_pdf=None):
    setp(10, "上传 PDF")
    resp = None
    for attempt in range(8):
        try:
            resp = client.post(
                SERVICE + "/service/translate/file",
                files={"file": ("input.pdf", pdf.read_bytes(), "application/pdf")},
                data={"payload": json.dumps(PAYLOAD)},
            )
            break
        except httpx.TransportError as e:
            if attempt == 7:
                setp(-1, "上传失败: {}".format(e))
                return False
            time.sleep(3)
    resp.raise_for_status()
    task_id = resp.json()["task_id"]

    setp(12, "解析与翻译中")
    last = ""
    fail_count = 0
    while True:
        try:
            st = client.get(SERVICE + "/service/status/" + task_id).json()
            fail_count = 0
        except httpx.TransportError:
            fail_count += 1
            if fail_count > 20:
                setp(-1, "与服务端的连接持续中断")
                return False
            time.sleep(2)
            continue
        msg = st.get("status_message", "")
        if msg != last:
            last = msg
            pct = st.get("progress_percent") or 0
            setp(max(15, min(90, int(pct))), msg)
        if st.get("error_flag"):
            setp(-1, "翻译失败: " + msg)
            return False
        if not st.get("is_processing") and st.get("download_ready"):
            break
        time.sleep(2)

    setp(95, "下载译文")
    # 必须校验状态码：服务端出错时返回的是 JSON 错误体（如"任务不支持下载 html
    # 类型的文件，或文件已丢失"），若当成正文保存，最终会生成一份只含 JSON 的 PDF
    try:
        dresp = client.get(SERVICE + "/service/download/" + task_id + "/html")
    except Exception as e:
        setp(-1, "下载译文失败: " + str(e))
        return False
    if dresp.status_code != 200:
        detail = dresp.text.replace("\n", " ").replace("\r", " ")[:200]
        setp(-1, "下载译文失败（HTTP " + str(dresp.status_code) + "）：" + detail)
        return False
    html = dresp.text
    stripped = html.lstrip()
    if stripped.startswith("{") and "detail" in stripped[:300]:
        setp(-1, "服务端返回错误：" + stripped[:200])
        return False
    html_path = work / "translated.html"
    html_path.write_text(html, encoding="utf-8")

    try:
        client.post(SERVICE + "/service/release/" + task_id)
    except Exception:
        pass

    # ===== Edge 无头打印为 PDF（在助手里做，插件只启动一次进程）=====
    setp(96, "生成 PDF（Edge 打印）…")
    edge = next((e for e in EDGE_CANDIDATES if pathlib.Path(e).exists()), None)
    if not edge:
        setp(-1, "未找到 Edge 浏览器，无法打印 PDF")
        return False
    pdf_path = work / "translated.pdf"
    edge_profile = work / "edge_profile"
    edge_profile.mkdir(exist_ok=True)
    # CREATE_NO_WINDOW: 不弹黑窗
    subprocess.Popen(
        [edge,
         "--headless", "--disable-gpu", "--no-pdf-header-footer",
         "--user-data-dir=" + str(edge_profile),
         "--print-to-pdf=" + str(pdf_path),
         "file:///" + str(html_path).replace("\\", "/")],
        creationflags=0x08000000, cwd=str(work))
    pdf_ok = False
    for _ in range(60):
        time.sleep(1)
        if pdf_path.exists() and pdf_path.stat().st_size > 0:
            time.sleep(1)  # 等文件写完
            pdf_ok = True
            break
    if not pdf_ok:
        setp(-1, "Edge 打印 PDF 超时")
        return False

    # 复制译文 PDF 到原 PDF 所在目录（用户要求译文与原 PDF 同目录）
    if dest_pdf:
        try:
            dest_pdf = pathlib.Path(dest_pdf)
            dest_pdf.parent.mkdir(parents=True, exist_ok=True)
            import shutil
            shutil.copyfile(pdf_path, dest_pdf)
            if not dest_pdf.exists() or dest_pdf.stat().st_size == 0:
                setp(-1, "复制译文到目标目录失败")
                return False
        except Exception as e:
            setp(-1, "复制译文到目标目录失败: {}".format(e))
            return False

    setp(100, "完成")
    return True


def main():
    global work, client
    args = sys.argv[1:]
    # 兼容旧模式参数：首参数若是模式名则跳过
    if args and args[0] in ("run", "ensure", "wait", "launch", "translate"):
        args.pop(0)
    if len(args) < 2:
        sys.exit(2)
    pdf = pathlib.Path(args[0])
    work = pathlib.Path(args[1])
    dest_pdf = args[2] if len(args) > 2 else None
    work.mkdir(parents=True, exist_ok=True)
    # 读取插件写入的配置（设置面板可改），覆盖默认值
    cfgp = work / "config.json"
    if cfgp.exists():
        try:
            cfg = json.loads(cfgp.read_text(encoding="utf-8"))
            PAYLOAD.update({k: v for k, v in cfg.items() if v not in (None, "")})
        except Exception:
            pass

    # === 配置规范化（防止面板填错导致 404 / 429）===
    # 1) 该字段是 base_url，DocuTranslate 内部会自行拼接 "/chat/completions"。
    #    若误填完整端点，会出现 ".../chat/completions/chat/completions" -> 404 page not found。
    bu = str(PAYLOAD.get("base_url", "")).strip().rstrip("/")
    for suffix in ("/chat/completions", "/completions"):
        if bu.endswith(suffix):
            bu = bu[: -len(suffix)].rstrip("/")
    PAYLOAD["base_url"] = bu

    # 2) 并发与限速：商汤 Token Plan 的 RPM/TPM 额度很紧，并发 >2 必撞 429；
    #    用内置 rpm 限速器把请求摊开（15 片约 3.5 分钟）。
    try:
        PAYLOAD["concurrent"] = max(1, min(int(PAYLOAD.get("concurrent", 2)), 2))
    except (TypeError, ValueError):
        PAYLOAD["concurrent"] = 2
    try:
        PAYLOAD["rpm"] = max(1, min(int(PAYLOAD.get("rpm") or 4), 4))
    except (TypeError, ValueError):
        PAYLOAD["rpm"] = 4

    # 3) 输出上限：轻量模型偶发陷入重复生成，流式响应会涨到几百 KB 仍不结束，
    #    表现为进度卡在 (n-1)/n 不动。限制 max_tokens 可强制收束。
    try:
        extra = json.loads(PAYLOAD.get("extra_body") or "{}")
        if not isinstance(extra, dict):
            extra = {}
    except Exception:
        extra = {}
    extra.setdefault("max_tokens", 8192)
    PAYLOAD["extra_body"] = json.dumps(extra)

    # 4) 推理型模型（deepseek-v4-flash 等）每片先产数百 reasoning token，
    #    在 Token Plan 的 TPM 额度下多分片必然 429，改用轻量模型。
    if PAYLOAD.get("model_id") in ("mimo-v2.5", "mimo-v2.5-pro", "deepseek-v4-flash", "deepseek-v4.1-flash"):
        PAYLOAD["model_id"] = "sensenova-6.8-flash-lite"
    # trust_env=False: 忽略 http_proxy 等环境代理，回环地址必须直连
    client = httpx.Client(timeout=180, trust_env=False)

    try:
        setp(2, "检查本地翻译服务")
        if not ensure_service():
            sys.exit(1)
        if not translate(pdf, dest_pdf):
            sys.exit(1)
    except Exception as e:
        setp(-1, "异常: {}".format(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
