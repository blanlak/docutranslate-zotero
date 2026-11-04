# -*- coding: utf-8 -*-
"""DocuTranslate Zotero 插件助手 v3
用法: python translate_helper.py run <input_pdf> <work_dir>
一次调用完成全部流程（插件只发起这一次进程启动）:
  1. 检查本地 DocuTranslate 服务；未启动则拉起（独立控制台+脱离作业）并等待就绪
  2. 上传 PDF -> 轮询翻译进度 -> 下载译文 HTML 到 work_dir/translated.html
进度文件: work_dir/progress.txt，格式 "<百分比> <消息>"；-1 失败
"""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

import httpx

# 所有本机相关路径均不写死：优先取 config.json（插件设置面板填写），
# 其次自动探测常见安装位置，最后才报错提示用户去设置里填写。
SERVICE = "http://127.0.0.1:8010"
PARTIAL_INFO = None  # 部分未翻译检测结果
SERVICE_EXE = ""   # 由 config.json 的 service_exe 提供，或自动探测
SERVICE_CWD = ""   # 由 config.json 的 service_cwd 提供
EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def _probe_service_exe():
    """自动探测 docutranslate.exe：PATH -> 常见 conda 环境位置"""
    exe = shutil.which("docutranslate")
    if exe and exe.lower().endswith(".exe"):
        return exe
    home = pathlib.Path(os.environ.get("USERPROFILE") or "")
    pdirs = [pathlib.Path(os.environ.get("ProgramData") or "C:/ProgramData")]
    candidates = []
    for base in [home / "miniforge3", home / "miniconda3", home / "anaconda3",
                 pdirs[0] / "miniforge3", pdirs[0] / "miniconda3", pdirs[0] / "anaconda3"]:
        candidates.append(base / "envs" / "docutranslate" / "Scripts" / "docutranslate.exe")
    for c in candidates:
        try:
            if c.is_file():
                return str(c)
        except Exception:
            pass
    return ""


def _probe_edge():
    for e in EDGE_CANDIDATES:
        try:
            if pathlib.Path(e).is_file():
                return e
        except Exception:
            pass
    return ""


PAYLOAD = {
    "workflow_type": "markdown_based",
    "convert_engine": "mineru",
    "model_version": "vlm",
    "formula_ocr": True,
    "base_url": "https://token.sensenova.cn/v1",
    "api_key": "",
    "model_id": "sensenova-6.8-flash-lite",
    "to_lang": "中文",
    "thinking": "disable",
    "chunk_size": 3000,
    "concurrent": 1,
    "temperature": 0.3,
    "timeout": 600,
    "retry": 5,
    "mineru_token": "",
}


def setp(pct, msg):
    (work / "progress.txt").write_text("{} {}".format(pct, msg), encoding="utf-8")


def service_up():
    try:
        client.get(SERVICE + "/service/meta")
        return True
    except Exception:
        return False


def _port_in_use(port=8010):
    """本机端口是否已被占用（被别的程序占用时，便携版会换端口导致插件连不上）"""
    import socket
    # 用连接探测：Windows 下对已被 0.0.0.0 监听的端口仍可 bind 成功，bind 判断不可靠
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.6)
    try:
        sock.connect(("127.0.0.1", port))
        return True
    except OSError:
        return False
    finally:
        try:
            sock.close()
        except Exception:
            pass


def _has_non_ascii(text):
    try:
        str(text).encode("ascii")
        return False
    except (UnicodeEncodeError, AttributeError):
        return True


def _short_path(p):
    """把含中文的路径转成 Windows 8.3 短路径（纯 ASCII）。
    便携版程序在中文目录下启动时，CreateProcess / PyInstaller 可能失败，
    用短路径可绕过；无 8.3 名称或调用失败时返回原路径。"""
    if not p or not _has_non_ascii(p):
        return p
    try:
        import ctypes
        from ctypes import wintypes
        fn = ctypes.windll.kernel32.GetShortPathNameW
        fn.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
        fn.restype = wintypes.DWORD
        buf = ctypes.create_unicode_buffer(32768)
        n = fn(str(p), buf, 32768)
        if n and n < 32768 and buf.value:
            return buf.value
    except Exception:
        pass
    return p


def _prepare_exe_path(exe_path):
    """处理含中文的程序路径：
    1) 能转 8.3 短路径就转（纯 ASCII）
    2) 转不了就把程序复制到纯英文临时目录再启动（仅对单文件便携版有效）
    返回可安全启动的路径。"""
    if not exe_path or not _has_non_ascii(exe_path):
        return exe_path

    short = _short_path(exe_path)
    if short != exe_path and not _has_non_ascii(short):
        setp(4, "路径含中文，已转换为短路径启动")
        return short

    # 短路径不可用（系统禁用了 8.3 名称）→ 复制到英文临时目录
    try:
        import shutil
        import tempfile
        src = pathlib.Path(exe_path)
        if not src.is_file():
            return exe_path
        dst_dir = pathlib.Path(tempfile.gettempdir()) / "DocuTranslatePortable"
        dst_dir.mkdir(parents=True, exist_ok=True)
        dst = dst_dir / "DocuTranslate-portable.exe"
        need_copy = True
        if dst.exists():
            try:
                need_copy = dst.stat().st_size != src.stat().st_size
            except OSError:
                need_copy = True
        if need_copy:
            setp(5, "路径含中文，正在准备可执行副本（首次约需几秒）…")
            shutil.copy2(str(src), str(dst))
        return str(dst)
    except Exception:
        return exe_path


def ensure_service():
    """检查服务；未启动则拉起并等待就绪。返回 True/False"""
    if service_up():
        time.sleep(1)
        if service_up():
            return True

    setp(4, "服务未启动，正在拉起…")
    if not SERVICE_EXE:
        setp(-1, "未配置 DocuTranslate 程序路径：请到 Zotero 设置 → DocuTranslate 翻译 → "
                 "运行环境 中填写 docutranslate.exe（或便携版 exe）的完整路径")
        return False
    # 用户可能粘贴带引号的路径，校验前先清理
    exe_path = str(SERVICE_EXE).strip().strip('"').strip("'")
    if not pathlib.Path(exe_path).is_file():
        setp(-1, "找不到 DocuTranslate 程序：{}".format(exe_path))
        return False

    # 端口被别的程序占用时，服务会自动改用其它端口，插件固定连 8010 必然失败
    if _port_in_use(8010):
        setp(-1, "端口 8010 已被其它程序占用，DocuTranslate 会改用其它端口导致无法连接。"
                 "请先关闭占用 8010 的程序后重试。")
        return False

    # 路径清理与校验：用户可能把「文件路径」当工作目录填、或粘贴带引号的路径，
    # 直接传给 Popen(cwd=...) 会抛 WinError 267（目录名称无效）
    exe_dir = str(pathlib.Path(exe_path).parent)
    workdir = str(SERVICE_CWD or "").strip().strip('"').strip("'")
    if workdir and not os.path.isdir(workdir):
        setp(4, "工作目录无效，已自动改用程序所在目录：{}".format(exe_dir))
        workdir = exe_dir
    if not workdir:
        workdir = exe_dir
    if not os.path.isdir(workdir):
        workdir = None  # 最后兜底：继承当前进程目录

    # 中文路径兼容：先试 8.3 短路径，不行就复制到英文临时目录
    prepared = _prepare_exe_path(exe_path)
    if prepared != exe_path:
        exe_path = prepared
        exe_dir = str(pathlib.Path(exe_path).parent)
        workdir = exe_dir

    # pip/conda 版 CLI 需要 -i 启动 Web 界面；便携版不解析参数，传了也无害
    args = [exe_path, "-i"]
    # CREATE_NEW_CONSOLE = 独立控制台；CREATE_BREAKAWAY_FROM_JOB = 脱离父作业对象
    proc = None
    # 顺序很关键：在受控作业对象里 CREATE_BREAKAWAY_FROM_JOB 必然返回 WinError 5，
    # 因此先试普通独立控制台，失败再尝试脱离作业，最后退到无特殊标志。
    launch_attempts = [
        subprocess.CREATE_NEW_CONSOLE,
        subprocess.CREATE_NEW_CONSOLE | 0x01000000,
        0,
    ]
    last_err = None
    for flags in launch_attempts:
        try:
            proc = subprocess.Popen(args, cwd=workdir, creationflags=flags)
            break
        except Exception as e:
            last_err = e
            proc = None
    if proc is None:
        hint = ""
        if _has_non_ascii(str(SERVICE_EXE)) or _has_non_ascii(str(SERVICE_CWD or "")):
            hint = "。路径中包含中文，建议把 DocuTranslate 移到纯英文目录（如 D:////DocuTranslate）后重试"
        setp(-1, "无法启动 DocuTranslate：{}{}".format(last_err, hint))
        return False

    # 进程秒退通常意味着启动失败（被杀毒拦截、缺依赖、路径带特殊字符等）
    time.sleep(3)
    if proc.poll() is not None:
        setp(-1, "DocuTranslate 启动后立即退出（退出码 {}）。常见原因：安全软件拦截、"
                 "程序文件损坏。请手动双击它确认能否正常启动。".format(proc.returncode))
        return False

    # 便携版首次运行要解压（约 10-30 秒），慢机器可能更久 —— 最多等 180 秒
    for i in range(90):
        time.sleep(2)
        try:
            setp(4, "等待翻译服务就绪…（{} 秒）".format((i + 1) * 2))
        except Exception:
            pass
        if service_up():
            time.sleep(1)
            if service_up():
                return True
    setp(-1, "翻译服务启动超时（已等 180 秒）。请手动双击 DocuTranslate 启动，"
             "看到 Uvicorn running on http://127.0.0.1:8010 后再右键翻译。")
    return False


def _detect_partial_translation(html_text):
    """粗略检测"部分段落没翻译"。
    DocuTranslate 旧版（<=1.7.9）在分片请求失败时会直接把原文回填且不报错，
    表现为译文里混着成段英文。这里按段落统计含中文的比例。
    返回 (总段落数, 已翻译段落数)；不明显时返回 None。"""
    import re
    try:
        blocks = re.findall(r"<(p|td|li|h[1-6])[^>]*>(.*?)</\1>", html_text, re.S)
    except Exception:
        return None
    total = 0
    zh = 0
    for _tag, raw in blocks:
        text = re.sub(r"<[^>]+>", " ", raw)
        text = re.sub(r"\s+", " ", text).strip()
        if len(text) < 40:      # 太短（图注、表头、页码）不计入
            continue
        total += 1
        if re.search(r"[\u4e00-\u9fff]", text):
            zh += 1
    if total >= 8 and zh / total < 0.75:
        return total, zh
    return None


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
    try:
        (work / "service_task_id.txt").write_text(str(task_id), encoding="utf-8")
    except Exception:
        pass

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
    # 留存服务端日志：分片失败会被记录在这里（429 / 超时 / 输出截断）
    try:
        lg = client.get(SERVICE + "/service/logs/" + task_id)
        if lg.status_code == 200:
            (work / "service_log.json").write_text(lg.text, encoding="utf-8")
    except Exception:
        pass

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

    # 部分段落未翻译检测（旧版 DocuTranslate 分片失败会静默回填原文）
    global PARTIAL_INFO
    try:
        PARTIAL_INFO = _detect_partial_translation(html)
    except Exception:
        PARTIAL_INFO = None

    try:
        client.post(SERVICE + "/service/release/" + task_id)
    except Exception:
        pass

    # ===== Edge 无头打印为 PDF（在助手里做，插件只启动一次进程）=====
    setp(96, "生成 PDF（Edge 打印）…")
    edge = next((e for e in EDGE_CANDIDATES if pathlib.Path(e).exists()), None) or _probe_edge()
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

    if PARTIAL_INFO:
        total, zh = PARTIAL_INFO
        setp(100, "完成，但有 {} / {} 段未翻译（建议升级 DocuTranslate 到 1.7.10 或把分块降小）"
             .format(total - zh, total))
    else:
        setp(100, "完成")
    return True


def main():
    global work, client, SERVICE, SERVICE_EXE, SERVICE_CWD, EDGE_CANDIDATES
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
    cfg = {}
    if cfgp.exists():
        try:
            cfg = json.loads(cfgp.read_text(encoding="utf-8"))
            PAYLOAD.update({k: v for k, v in cfg.items() if v not in (None, "")})
        except Exception:
            pass

    # === 本机路径：配置优先，其次自动探测 ===
    # 服务固定在本机回环地址（本插件只对接本地 DocuTranslate）
    SERVICE = "http://127.0.0.1:8010"
    SERVICE_EXE = str(cfg.get("service_exe") or "").strip()
    SERVICE_CWD = str(cfg.get("service_cwd") or "").strip()
    if not SERVICE_EXE:
        SERVICE_EXE = _probe_service_exe()
    if SERVICE_EXE and not SERVICE_CWD:
        # 约定：<env>/Scripts/docutranslate.exe -> 仓库目录通常需用户填写，
        # 探测失败时退回 exe 所在目录，至少能让服务自身正常启动
        SERVICE_CWD = str(pathlib.Path(SERVICE_EXE).parent)

    edge_cfg = str(cfg.get("edge_path") or "").strip()
    if edge_cfg:
        EDGE_CANDIDATES = [edge_cfg]

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
        PAYLOAD["concurrent"] = max(1, min(int(PAYLOAD.get("concurrent", 2)), 3))
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
    # 回环地址必须直连（忽略 http_proxy）；远端服务则走系统代理
    _is_local = SERVICE.startswith(("http://127.0.0.1", "http://localhost"))
    client = httpx.Client(timeout=180, trust_env=not _is_local)

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
