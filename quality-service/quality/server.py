"""标准库 HTTP 内部分析服务；外部请求必须经过现有项目 API 的权限验证。"""

import hmac
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from .apk import DEFAULT_RULES, validate_evidence, validate_rules
from .reports import comparison, html_report
from .storage import Store

ROOT = Path(os.environ.get("QUALITY_DATA_DIR", "./data/quality")).resolve()
MAX_UPLOAD = 1024**3
MAX_PENDING = 8
POOL = ThreadPoolExecutor(max_workers=1)
SLOTS = threading.BoundedSemaphore(MAX_PENDING)
STORE = None


def validate_options(value, kind):
    """作用：校验任务配置；入参：参数字典和类型；返回：经过限制的参数。"""
    if not isinstance(value, dict):
        raise ValueError("参数必须为对象")
    result = {"kind": kind}
    for key in ("process_name", "device", "scene", "build", "graphics_api", "resolution", "quality", "probe"):
        text = value.get(key, "")
        if not isinstance(text, str) or len(text) > 200:
            raise ValueError(f"{key} 必须为不超过 200 字的文本")
        result[key] = text
    for key, default, low, high in (("target_fps", 60, 1, 360), ("sample_interval_s", 1, .0001, 60)):
        number = value.get(key, default)
        if isinstance(number, bool) or not isinstance(number, (float, int)) or not low <= number <= high:
            raise ValueError(f"{key} 必须在 {low}~{high} 之间")
        result[key] = number
    if kind == "apk":
        result["rules"] = validate_rules(value.get("rules", {}))
        result["build_evidence"] = validate_evidence(value.get("build_evidence", {}))
    return result


def execute_job(job_id, input_path, options):
    """作用：执行有超时的独立分析进程；入参：任务、输入路径、配置；返回：无，更新历史状态。"""
    folder = input_path.parent
    try:
        STORE.update(job_id, "running")
        options_path, output_path = folder / "options.json", folder / "report.json"
        options_path.write_text(json.dumps(options), encoding="utf-8")
        process = subprocess.Popen([sys.executable, "-m", "quality.worker", str(input_path), str(options_path), str(output_path)],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
            start_new_session=os.name != "nt", creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0)
        try:
            _, stderr = process.communicate(timeout=180)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],capture_output=True,timeout=15)
            else:
                os.killpg(process.pid,signal.SIGKILL)
            process.communicate(timeout=10)
            raise
        if process.returncode:
            raise ValueError(stderr.strip()[-1800:] or "分析进程未正常结束")
        if output_path.stat().st_size > 64 * 1024**2:
            raise ValueError("报告超过 64 MiB，请拆分输入")
        report = json.loads(output_path.read_text(encoding="utf-8"))
        summary = {"risk_counts": {level: sum(risk["level"] == level for risk in report["risks"]) for level in ("P0", "P1", "P2")},
            "format": report["format"], "metrics": report.get("metrics"), "apk_bytes": report.get("apk_bytes"),
            "sample_count": report.get("sample_count"), "file_count": report.get("file_count")}
        STORE.update(job_id, "completed", summary)
    except subprocess.TimeoutExpired:
        STORE.update(job_id, "failed", error="任务超过 180 秒，已终止。请按场景拆分输入")
    except Exception as error:
        STORE.update(job_id, "failed", error=str(error)[:1800])
    finally:
        SLOTS.release()


class Handler(BaseHTTPRequestHandler):
    """分析服务内部路由。项目标识由网关验证，内部密钥仅在服务间传递。"""

    def log_message(self, format, *args):
        """作用：关闭默认请求日志以减少文件名泄露；入参：格式与日志参数；返回：无。"""
        return

    def reply(self, status, value, content_type="application/json; charset=utf-8"):
        """作用：发送长度明确的响应；入参：状态、正文、类型；返回：无。"""
        data = json.dumps(value, ensure_ascii=False, allow_nan=False).encode() if content_type.startswith("application/json") else value.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        """作用：处理历史、任务、对比和导出读取；入参：HTTP 请求；返回：HTTP 响应。"""
        self.dispatch("GET")

    def do_POST(self):
        """作用：处理文件导入；入参：HTTP 请求；返回：异步任务响应。"""
        self.dispatch("POST")

    def do_PUT(self):
        """作用：保存项目红线；入参：HTTP 请求；返回：规则对象。"""
        self.dispatch("PUT")

    def do_DELETE(self):
        """作用：删除任务及原始附件；入参：HTTP 请求；返回：删除结果。"""
        self.dispatch("DELETE")

    def read_json(self):
        """作用：读取受限 JSON；入参：HTTP 正文；返回：解析对象。"""
        length = int(self.headers.get("Content-Length", 0))
        if not 0 < length <= 200_000:
            raise ValueError("JSON 参数大小必须在 1~200000 字节")
        return json.loads(self.rfile.read(length))

    def dispatch(self, method):
        """作用：验证内部身份并分发路径；入参：方法名称；返回：HTTP 响应。"""
        try:
            key = os.environ.get("QUALITY_SERVICE_KEY", "")
            if len(key) < 32 or not hmac.compare_digest(key, self.headers.get("X-Quality-Key", "")):
                return self.reply(401, {"message": "内部服务认证失败"})
            parsed = urlsplit(self.path)
            parts = parsed.path.strip("/").split("/")
            if parts == ["health"]:
                return self.reply(200, {"status": "ok", "perfetto": Path(os.environ.get("TRACE_PROCESSOR_PATH", "")).is_file()})
            if len(parts) < 3 or parts[0] != "projects":
                return self.reply(404, {"message": "接口不存在"})
            project_id = str(uuid.UUID(parts[1]))
            query = parse_qs(parsed.query)
            resource = parts[2]
            if resource == "configs" and method == "POST":
                body = self.read_json()
                kind = body.get("kind")
                if kind not in ("performance", "apk"):
                    raise ValueError("任务类型无效")
                return self.reply(201, {"id": STORE.config(project_id, value=validate_options(body, kind))})
            if resource == "rules":
                value = validate_rules(self.read_json()) if method == "PUT" else None
                return self.reply(200, {"rules": {**DEFAULT_RULES, **STORE.rules(project_id, value)}})
            if resource == "jobs" and len(parts) == 3:
                kind = query.get("kind", ["performance"])[0]
                if kind not in ("performance", "apk"):
                    raise ValueError("任务类型无效")
                if method == "POST":
                    return self.upload(project_id, kind)
                return self.reply(200, {"items": STORE.list(project_id, kind)})
            if resource == "compare" and method == "GET":
                ids = query.get("ids", [""])[0].split(",")
                if not 2 <= len(ids) <= 6 or len(set(ids)) != len(ids):
                    raise ValueError("需要 2~6 个不同任务")
                jobs, reports = [], []
                for job_id in ids:
                    job, report = self.completed(project_id, job_id)
                    jobs.append(job)
                    reports.append(report)
                return self.reply(200, comparison(jobs, reports))
            if resource == "jobs" and len(parts) >= 4:
                job_id = str(uuid.UUID(parts[3]))
                job = STORE.get(project_id, job_id)
                if not job:
                    return self.reply(404, {"message": "任务不存在"})
                if method == "DELETE":
                    if job["status"] in ("queued", "running"):
                        return self.reply(409, {"message": "任务执行中，暂不能删除"})
                    shutil.rmtree(ROOT / job_id)
                    with STORE.connection() as db:
                        db.execute("DELETE FROM jobs WHERE id=? AND project_id=?", (job_id, project_id))
                    return self.reply(200, {"ok": True})
                if len(parts) == 4:
                    return self.reply(200, job)
                job, report = self.completed(project_id, job_id)
                if parts[4] == "report.html":
                    return self.reply(200, html_report(job, report), "text/html; charset=utf-8")
                if parts[4] == "report":
                    return self.reply(200, report)
            return self.reply(404, {"message": "接口不存在"})
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            return self.reply(400, {"message": str(error)[:1600]})
        except Exception:
            return self.reply(500, {"message": "分析服务异常，请检查服务状态"})

    def completed(self, project_id, job_id):
        """作用：读取已完成任务及报告；入参：项目和任务标识；返回：任务、报告元组。"""
        job_id = str(uuid.UUID(job_id))
        job = STORE.get(project_id, job_id)
        if not job or job["status"] != "completed":
            raise ValueError("任务不存在或尚未完成")
        report = json.loads((ROOT / job_id / "report.json").read_text(encoding="utf-8"))
        return job, report

    def upload(self, project_id, kind):
        """作用：有界流式保存上传并排队；入参：项目标识和类型；返回：202 任务元信息。"""
        length = int(self.headers.get("Content-Length", 0))
        if not 0 < length <= MAX_UPLOAD:
            return self.reply(413, {"message": "文件必须大于 0 且不超过 1 GiB"})
        options = STORE.config(project_id, self.headers.get("X-Analysis-Config", ""))
        if options["kind"] != kind:
            raise ValueError("上传类型与配置不一致")
        filename = Path(unquote(self.headers.get("X-Filename", "upload.bin")).replace("\\", "/")).name[:200]
        if not filename or "\x00" in filename:
            raise ValueError("文件名无效")
        if not SLOTS.acquire(blocking=False):
            return self.reply(429, {"message": "任务队列已满（最多 8 项），请稍后重试"})
        job_id = str(uuid.uuid4())
        folder = ROOT / job_id
        try:
            folder.mkdir()
            input_path = folder / ("input" + Path(filename).suffix.lower())
            if shutil.disk_usage(ROOT).free < length + 256 * 1024**2:
                raise ValueError("磁盘空间不足，请清理历史任务")
            self.connection.settimeout(60)
            remaining = length
            with input_path.open("wb") as target:
                while remaining:
                    chunk = self.rfile.read(min(1024 * 1024, remaining))
                    if not chunk:
                        raise ValueError("上传中断")
                    target.write(chunk)
                    remaining -= len(chunk)
            STORE.create(job_id, project_id, kind, filename, options)
            POOL.submit(execute_job, job_id, input_path, options)
        except Exception:
            shutil.rmtree(folder, ignore_errors=True)
            SLOTS.release()
            raise
        return self.reply(202, STORE.get(project_id, job_id))


def main():
    """作用：启动内部分析服务；入参：环境变量；返回：无，持续提供 HTTP 服务。"""
    global STORE
    if len(os.environ.get("QUALITY_SERVICE_KEY", "")) < 32:
        raise SystemExit("QUALITY_SERVICE_KEY 至少 32 字符")
    STORE = Store(ROOT)
    server = ThreadingHTTPServer((os.environ.get("QUALITY_HOST", "127.0.0.1"), int(os.environ.get("QUALITY_PORT", "8090"))), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    finally:
        server.server_close()
        POOL.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    main()
