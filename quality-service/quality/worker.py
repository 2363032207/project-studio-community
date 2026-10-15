"""独立分析进程：由服务端设定超时，Linux 下限制内存，不访问远端业务系统。"""

import json
import sys
from pathlib import Path

from .apk import analyze_apk
from .performance import analyze_performance
from .unity import convert_native


def run(input_path, options_path, output_path):
    """作用：执行单个隔离任务；入参：输入/参数/报告路径；返回：无，写入报告文件。"""
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (1536 * 1024**2, 1536 * 1024**2))
    except ImportError:
        pass
    options = json.loads(Path(options_path).read_text(encoding="utf-8"))
    if options["kind"] == "performance" and Path(input_path).suffix.lower() in (".raw", ".data"):
        input_path = convert_native(Path(input_path))
    analyzer = analyze_apk if options["kind"] == "apk" else analyze_performance
    result = analyzer(Path(input_path), options)
    result["analyzer_version"] = "1.0.0"
    Path(output_path).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")


if __name__ == "__main__":
    try:
        run(*sys.argv[1:4])
    except Exception as error:
        # 只返回可操作的错误消息，避免 traceback 泄露服务器目录或配置。
        print(f"分析失败：{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
