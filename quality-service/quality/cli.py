"""无需 Web 系统的本地命令行分析入口。"""

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path

from .apk import analyze_apk
from .performance import analyze_performance
from .reports import html_report
from .server import validate_options
from .unity import convert_native


def main():
    """作用：执行本地单文件分析；入参：命令行文件/类型/选项/输出路径；返回：写入 JSON 与 HTML。"""
    parser = argparse.ArgumentParser(description="游戏性能与 APK 质量分析")
    parser.add_argument("file", type=Path)
    parser.add_argument("--kind", choices=("performance", "apk"), required=True)
    parser.add_argument("--options", type=Path)
    parser.add_argument("--output", type=Path, default=Path("data/report"))
    args = parser.parse_args()
    options = validate_options(json.loads(args.options.read_text(encoding="utf-8")) if args.options else {}, args.kind)
    source = convert_native(args.file) if args.kind == "performance" and args.file.suffix.lower() in (".raw", ".data") else args.file
    report = (analyze_apk if args.kind == "apk" else analyze_performance)(source, options)
    report["analyzer_version"] = "1.0.0"
    job = {"filename": args.file.name, "created_at": datetime.now(timezone.utc).isoformat()}
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    (args.output / "report.html").write_text(html_report(job, report), encoding="utf-8")
    print(f"分析完成，风险 {len(report['risks'])} 项；报告目录：{args.output.resolve()}")


if __name__ == "__main__":
    main()
