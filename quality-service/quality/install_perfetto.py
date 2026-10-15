"""显式安装官方、固定版本且校验 SHA-256 的 Trace Processor；仅部署时运行。"""

import hashlib
import platform
import sys
from pathlib import Path
from urllib.request import urlopen


def install(destination):
    """作用：取得固定版本官方解析器；入参：安装目标路径；返回：安装后的绝对路径。"""
    from perfetto.prebuilts.manifests.trace_processor_shell import TRACE_PROCESSOR_SHELL_MANIFEST
    entry = next((item for item in TRACE_PROCESSOR_SHELL_MANIFEST
                  if item.get("platform") == sys.platform.lower() and platform.machine().lower() in item.get("machine", [])), None)
    if not entry:
        raise ValueError("当前系统没有官方 Trace Processor 预编译包")
    target = Path(destination).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and hashlib.sha256(target.read_bytes()).hexdigest() == entry["sha256"]:
        return str(target)
    temporary = target.with_suffix(target.suffix + ".download")
    digest = hashlib.sha256()
    try:
        with urlopen(entry["url"], timeout=90) as source, temporary.open("wb") as output:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise ValueError("Trace Processor SHA-256 校验失败")
        temporary.replace(target)
    finally:
        if temporary.exists():
            temporary.unlink()
    target.chmod(0o755)
    return str(target)


if __name__ == "__main__":
    print(install(sys.argv[1]))
