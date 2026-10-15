"""离线 HTML 报告与多任务对比；不包含第三方脚本或外部网络引用。"""

import html
import json
import statistics

CONDITIONS = ("device", "scene", "build", "graphics_api", "resolution", "quality", "probe", "target_fps")


def comparison(jobs, reports):
    """作用：对比同类任务；入参：任务和报告列表；返回：指标变化、条件差异与历史趋势数据。"""
    if not 2 <= len(jobs) <= 6 or len({job["kind"] for job in jobs}) != 1:
        raise ValueError("请选择 2~6 个同类型已完成任务")
    keys = ("fps_avg", "fps_1pct_low", "jank_pct", "memory_growth_mb", "memory_slope_mb_min", "gc_total_ms") if jobs[0]["kind"] == "performance" else ("apk_bytes", "uncompressed_bytes", "file_count", "shader_variants")
    rows, differences, unknown = [], [], []
    if jobs[0]["kind"] == "performance":
        for field in CONDITIONS:
            values = [job["options"].get(field) for job in jobs]
            if any(value in (None, "") for value in values):
                unknown.append(field)
            if len({str(value) for value in values}) > 1:
                differences.append(field)
    for index, (job, report) in enumerate(zip(jobs, reports)):
        metrics = report.get("metrics", report)
        values = {key: metrics.get(key) for key in keys}
        base = reports[0].get("metrics", reports[0])
        delta = {key: (values[key] - base[key]) / abs(base[key]) * 100
                 if isinstance(values[key], (int, float)) and isinstance(base.get(key), (int, float)) and base[key] != 0 else None for key in keys}
        rows.append({"id": job["id"], "filename": job["filename"], "created_at": job["created_at"], "values": values, "delta_pct": delta})
    return {"baseline_id": jobs[0]["id"], "rows": rows, "condition_differences": differences,
        "unknown_conditions": unknown, "comparable": not differences and not unknown,
        "warnings": ["第一项为基线；百分比只表示数值变化，正负不直接代表改善。",
                     "单轮对比不证明优化收益；同设备同场景至少各复跑三轮，再比较方差。"],
        "statistics": {key: {"mean": statistics.mean([row["values"][key] for row in rows if isinstance(row["values"][key], (int, float))]),
                              "count": sum(isinstance(row["values"][key], (int, float)) for row in rows)}
                       for key in keys if any(isinstance(row["values"][key], (int, float)) for row in rows)}}


def html_report(job, report):
    """作用：生成可保存/打印的离线报告；入参：任务与分析报告；返回：UTF-8 HTML 字符串。"""
    escape = html.escape
    risks = "".join(f"<article class='{escape(risk['level'])}'><b>{escape(risk['level'])} · {escape(risk['title'])}</b>"
                    f"<p>{escape(risk.get('path',''))}</p><p>{escape(risk.get('evidence',''))}</p>"
                    f"<p>建议：{escape(risk['suggestion'])}</p></article>" for risk in report["risks"])
    summary = report.get("metrics", {key: report.get(key) for key in ("apk_bytes", "uncompressed_bytes", "file_count", "checks")})
    warnings = "".join(f"<li>{escape(value)}</li>" for value in report.get("warnings", []) + report.get("notes", []))
    # HTML 内容全部转义，文件名、日志和资源路径均不能注入脚本。
    return f"""<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>游戏质量分析报告</title>
      <style>body{{font:15px system-ui;max-width:1100px;margin:40px auto;padding:20px;color:#17233d}}
      article{{border:1px solid #ddd;border-left:5px solid #ebad45;padding:16px;margin:16px 0;break-inside:avoid}}
      .P0,.P1{{border-left-color:#dc435d}}pre{{white-space:pre-wrap;word-break:break-all;background:#f4f6fa;padding:18px}}</style>
      <h1>游戏质量分析报告</h1><p>{escape(job['filename'])} · {escape(job['created_at'])} · 分析器 {escape(report['analyzer_version'])}</p>
      <h2>指标与可用性</h2><pre>{escape(json.dumps(summary,ensure_ascii=False,indent=2))}</pre>
      <h2>风险与建议</h2>{risks or '<p>当前已采集数据未触发红线；未采集项不代表通过。</p>'}
      <h2>数据口径与限制</h2><ul>{warnings}</ul><details><summary>完整报告数据</summary>
      <pre>{escape(json.dumps(report,ensure_ascii=False,indent=2))}</pre></details></html>"""
