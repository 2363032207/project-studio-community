"""本地 Web 全链路验证：仅上传生成的虚构样例，不回显账号、密码或 Token。"""

import json
import os
import time
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from generate_samples import generate


def request(path, token=None, method="GET", value=None, headers=None, raw=False):
    """作用：调用本地 API；入参：相对路径、令牌、方法、正文与头；返回：JSON 对象或原始正文。"""
    request_headers = {"Authorization":f"Bearer {token}"} if token else {}
    request_headers.update(headers or {})
    if isinstance(value, dict):
        value = json.dumps(value).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    with urlopen(Request("http://127.0.0.1:8088"+path, data=value, headers=request_headers, method=method),timeout=30) as response:
        body = response.read()
        return body if raw else json.loads(body)


def upload(base, token, path, kind, options):
    """作用：上传样例并等待任务结束；入参：项目接口、身份、路径、类型、配置；返回：最终任务。"""
    config = request(base+"/configs",token,"POST",{**options,"kind":kind})
    job = request(base+f"/jobs?kind={kind}",token,"POST",path.read_bytes(),
        {"Content-Type":"application/octet-stream","X-Filename":quote(path.name),"X-Analysis-Config":config["id"]})
    for _ in range(40):
        job = request(base+"/jobs/"+job["id"],token)
        if job["status"] not in ("queued","running"):
            return job
        time.sleep(.5)
    raise AssertionError("样例任务未在 20 秒内结束")


def main():
    """作用：验证上传/报告/对比/规则/隔离/失败处理；入参：本地测试账号环境变量；返回：断言通过或非零退出。"""
    credentials = {"email":os.environ["QUALITY_TEST_EMAIL"],"password":os.environ["QUALITY_TEST_PASSWORD"]}
    token = request("/api/auth/login",method="POST",value=credentials)["token"]
    projects = request("/api/projects",token)["items"]
    if not projects:
        raise AssertionError("请先在本地创建演示项目")
    project_id = os.environ.get("QUALITY_TEST_PROJECT_ID",projects[0]["id"])
    base = f"/api/projects/{project_id}/quality"
    folder = Path("data/web-smoke")
    generate(folder)
    conditions = {"device":"DemoDevice","scene":"DemoArena","build":"demo-1","graphics_api":"Vulkan",
        "resolution":"1920x1080","quality":"medium","probe":"baseline","target_fps":60}
    baseline = upload(base,token,folder/"performance-baseline.csv","performance",conditions)
    candidate = upload(base,token,folder/"performance-candidate.csv","performance",conditions)
    log = upload(base,token,folder/"game-runtime.txt","performance",conditions)
    trace = upload(base,token,folder/"demo-trace.json","performance",{**conditions,"process_name":"com.example.game"})
    evidence = json.loads((folder/"build-evidence.json").read_text())
    apk = upload(base,token,folder/"demo-game.apk","apk",{"build_evidence":evidence})
    for job in (baseline,candidate,log,trace,apk):
        assert job["status"]=="completed", (job["filename"],job.get("error"))
    result = request(base+f"/compare?ids={baseline['id']},{candidate['id']}",token)
    assert result["comparable"] and result["rows"][1]["values"]["jank_pct"]==0
    perf = request(base+f"/jobs/{baseline['id']}/report",token)
    package = request(base+f"/jobs/{apk['id']}/report",token)
    assert perf["metrics"]["memory_growth_mb"]>10
    assert package["checks"]["references"]=="build_evidence"
    assert package["duplicates"] and package["unused_candidates"]
    assert b"<!doctype html>" in request(base+f"/jobs/{apk['id']}/report.html",token,raw=True)
    rules = request(base+"/rules",token)["rules"]
    assert request(base+"/rules",token,"PUT",rules)["rules"]==rules
    native = folder/"unsupported.raw"
    native.write_bytes(b"\x00binary-unity-placeholder")
    failed = upload(base,token,native,"performance",{})
    assert failed["status"]=="failed" and "Unity" in failed["error"]
    try:
        request(f"/api/projects/{uuid.uuid4()}/quality/jobs/{apk['id']}",token)
        raise AssertionError("跨项目读取必须拒绝")
    except HTTPError as error:
        assert error.code==404
    request(base+f"/jobs/{failed['id']}",token,"DELETE")
    print("PASS: CSV/日志/Trace JSON/APK 上传、后台执行、对象历史、对比、规则、HTML、项目隔离和失败状态")
    print("Performance sample job:",baseline["id"])
    print("APK sample job:",apk["id"])


if __name__ == "__main__":
    main()
