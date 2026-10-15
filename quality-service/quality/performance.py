"""游戏性能数据解析与证据化分析，所有时间统一为秒或毫秒。"""

import csv
import io
import json
import math
import os
import re
import statistics
from bisect import bisect_left
from collections import Counter
from pathlib import Path

MAX_SAMPLES = 500_000
ALIASES = {
    "time_s": ["time_s", "timestamp_s", "elapsed_s", "time", "seconds"],
    "frame_ms": ["frame_ms", "frame_time_ms", "frametime_ms", "frame time ms", "cpu frame time"],
    "fps": ["fps", "frame_rate"],
    "cpu_ms": ["cpu_ms", "cpu_main_ms", "main_thread_ms", "cpu time ms"],
    "gpu_ms": ["gpu_ms", "gpu_frame_ms", "gpu time ms"],
    "gpu_load_pct": ["gpu_load_pct", "gpu_usage", "gpu_utilization"],
    "memory_mb": ["memory_mb", "unity_allocated_mb", "total_used_memory_mb", "rss_mb"],
    "gc_ms": ["gc_ms", "gc_time_ms"],
    "gc_count": ["gc_count", "gc_collections"],
    "cpu_freq_mhz": ["cpu_freq_mhz", "frequency_mhz"],
    "temperature_c": ["temperature_c", "battery_temp_c"],
}


def number(value):
    """作用：读取有限非负数；入参：任意值；返回：浮点数或 None（不支持/缺失）。"""
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) and parsed >= 0 else None
    except (TypeError, ValueError):
        return None


def percentile(values, fraction):
    """作用：线性插值分位数；入参：数列和 0~1 分位；返回：分位值或 None。"""
    if not values:
        return None
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    low, high = math.floor(position), math.ceil(position)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def normalize(rows, interval):
    """作用：标准化采样字段并保留缺失；入参：原始行与采样间隔秒；返回：标准行列表。"""
    if len(rows) > MAX_SAMPLES:
        raise ValueError("采样超过 500000 行，请按场景或时间段拆分")
    samples = []
    for index, row in enumerate(rows):
        fields = {str(key).strip().lower(): value for key, value in row.items()}
        sample = {}
        for metric, names in ALIASES.items():
            sample[metric] = next((number(fields[name]) for name in names if name in fields), None)
        sample["time_s"] = sample["time_s"] if sample["time_s"] is not None else index * interval
        sample["scene"] = str(fields.get("scene", fields.get("scene_name", "未标记")))[:200]
        if str(fields.get("gpu_supported", "true")).lower() in ("false", "0"):
            sample["gpu_ms"] = None
            sample["gpu_load_pct"] = None
        if sample["frame_ms"] is None and sample["fps"] and sample["fps"] > 0:
            sample["frame_ms"] = 1000 / sample["fps"]
        samples.append(sample)
    samples.sort(key=lambda sample: sample["time_s"])
    return samples


def parse_logs(text):
    """作用：聚合游戏日志、堆栈和场景；入参：日志正文；返回：日志分组与可识别采样行。"""
    groups, rows, scene, current = {}, [], "未标记", None
    for index, line in enumerate(text.splitlines()):
        structured = {}
        if line.lstrip().startswith("{"):
            try:
                parsed_line = json.loads(line)
                if isinstance(parsed_line, dict):
                    structured = parsed_line
                    scene = str(structured.get("scene",scene))[:200]
                    if any(key in structured for key in ("fps","frame_ms","cpu_ms","memory_mb")):
                        rows.append({**structured,"scene":scene})
                    line = str(structured.get("level","")) + " " + str(structured.get("message",line))
            except json.JSONDecodeError:
                pass
        marker = re.search(r"(?:scene|场景)\s*[=:]\s*([\w./\-]+)", line, re.I)
        if marker:
            scene = marker.group(1)
        pairs = dict(re.findall(r"([a-zA-Z_]+)\s*[=:]\s*(-?\d+(?:\.\d+)?)", line))
        if any(key in pairs for key in ("fps", "frame_ms", "memory_mb", "cpu_ms")):
            rows.append({**pairs, "scene": scene})
        exception = re.search(r"[\w.]+(?:Exception|Error)",line,re.I)
        match = re.search(r"\b(FATAL|ERROR|WARN(?:ING)?)\b|\s([EFW])\s+[^:]+:", line, re.I)
        if exception or match:
            kind = exception.group(0) if exception else match.group(1) or match.group(2)
            severity = "warning" if kind.upper() in ("W", "WARN", "WARNING") else "error"
            signature = re.sub(r"0x[0-9a-fA-F]+|\b\d+\b", "#", line)[:400]
            key = (kind, signature, scene)
            timestamp = re.search(r"(?:\d{4}-)?\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?", line)
            current = groups.setdefault(key, {"type": kind, "severity": severity, "scene": scene,
                "message": line[:1500], "count": 0, "line": index + 1, "stack": [],
                "first_time": str(structured.get("timestamp")) if structured.get("timestamp") else timestamp.group(0) if timestamp else None})
            current["last_time"] = str(structured.get("timestamp")) if structured.get("timestamp") else timestamp.group(0) if timestamp else None
            current["count"] += 1
            extra_stack = structured.get("stack", [])
            if isinstance(extra_stack,str):
                extra_stack = extra_stack.splitlines()
            if isinstance(extra_stack,list) and not current["stack"]:
                current["stack"] = [str(value)[:1000] for value in extra_stack[:30]]
        elif current and re.match(r"\s*(at |---|Caused by:|[\w.]+\(.*\) \(at )", line):
            if len(current["stack"]) < 30:
                current["stack"].append(line[:1000])
        elif line.strip():
            current = None
        if len(groups) > 5000:
            raise ValueError("日志类型超过 5000 组，请拆分日志")
    return sorted(groups.values(), key=lambda group: -group["count"]), rows


def trace_events(data, process_name):
    """作用：解析 Chrome/Perfetto JSON 事件；入参：Trace JSON 和进程名；返回：采样、GC 事件、热点、警告。"""
    events = data.get("traceEvents", []) if isinstance(data, dict) else data
    if len(events) > 1_000_000:
        raise ValueError("Trace 事件超过 100 万，请裁剪后导入")
    processes = {str(e.get("pid")): str(e.get("args", {}).get("name", "")) for e in events
                 if e.get("ph") == "M" and e.get("name") == "process_name"}
    pids = {pid for pid, name in processes.items() if process_name and process_name in name}
    if process_name and not pids:
        raise ValueError("Trace 未找到指定进程名，请核对采集配置")
    complete, gc_events, counter_rows = [], [], []
    pending = {}
    for event in events:
        if pids and str(event.get("pid")) not in pids:
            continue
        phase = event.get("ph")
        key = (event.get("pid"), event.get("tid"))
        if phase == "B":
            pending.setdefault(key, []).append(event)
        elif phase == "E" and pending.get(key):
            start = pending[key].pop()
            complete.append({**start, "dur": event.get("ts", 0) - start.get("ts", 0)})
        elif phase == "X":
            complete.append(event)
        elif phase == "C":
            counter_rows.append({"time_s": event.get("ts", 0) / 1e6, **event.get("args", {})})
    frames = [{**event,"name":"Choreographer#doFrame" if str(event.get("name", "")).startswith("Choreographer#doFrame") else event.get("name")}
              for event in complete if (event.get("name") in ("PlayerLoop", "Frame", "GameFrame") or str(event.get("name", "")).startswith("Choreographer#doFrame")) and number(event.get("dur")) is not None]
    # 优先选择最常见的单一帧轨道，避免嵌套标记与多线程重复计算。
    tracks = Counter((e.get("pid"), e.get("tid"), e.get("name")) for e in frames)
    track = tracks.most_common(1)[0][0] if tracks else None
    rows = [{"time_s": e.get("ts", 0) / 1e6, "frame_ms": e["dur"] / 1000} for e in frames
            if (e.get("pid"), e.get("tid"), e.get("name")) == track]
    totals = {}
    for event in complete:
        duration = number(event.get("dur"))
        if duration is None:
            continue
        name = str(event.get("name", "unnamed"))
        value = totals.setdefault(name, {"name": name, "count": 0, "total_ms": 0, "max_ms": 0})
        value["count"] += 1
        value["total_ms"] += duration / 1000
        value["max_ms"] = max(value["max_ms"], duration / 1000)
        if re.search(r"GC\.Collect|GarbageCollect|GC\.Incremental", name):
            gc_events.append({"time_s": event.get("ts", 0) / 1e6, "duration_ms": duration / 1000, "name": name})
    warnings = ["Trace 帧标记耗时不等于呈现 FPS；热点为包含子调用的累计耗时，不能相加当作 CPU 总耗时。"]
    if not process_name:
        warnings.append("未指定进程名；自动选择样本最多的帧轨道，报告只供定位参考。")
    return rows + counter_rows, gc_events, sorted(totals.values(), key=lambda item: -item["total_ms"])[:30], warnings


def perfetto_binary(path, process_name):
    """作用：用官方 Trace Processor 解析二进制；入参：文件路径与目标进程；返回：标准行、GC、热点、警告。"""
    binary = os.environ.get("TRACE_PROCESSOR_PATH")
    if not binary or not Path(binary).is_file():
        raise ValueError("Perfetto 二进制需要 TRACE_PROCESSOR_PATH 指向官方 trace_processor_shell；或先导出 Trace JSON")
    try:
        from perfetto.trace_processor import TraceProcessor, TraceProcessorConfig
    except ImportError as error:
        raise ValueError("请安装 requirements-perfetto.txt 后重试") from error
    with TraceProcessor(trace=str(path), config=TraceProcessorConfig(bin_path=binary)) as processor:
        # 进程名只作为 SQL 字面量使用，转义单引号且不接受用户 SQL。
        escaped = process_name.replace("'", "''")
        scope = f"p.name LIKE '%{escaped}%'" if process_name else "1=1"
        query = f"""SELECT s.ts/1e9 AS time_s,s.dur/1e6 AS frame_ms,
          CASE WHEN s.name LIKE 'Choreographer#doFrame%' THEN 'Choreographer#doFrame' ELSE s.name END AS name,s.track_id
          FROM slice s JOIN thread_track t ON t.id=s.track_id JOIN thread th ON th.utid=t.utid
          JOIN process p ON p.upid=th.upid WHERE {scope} AND s.dur>0
          AND (s.name IN ('PlayerLoop','Frame','GameFrame') OR s.name LIKE 'Choreographer#doFrame%') LIMIT 500001"""
        frame_rows = [dict(time_s=r.time_s, frame_ms=r.frame_ms, track_id=r.track_id, name=r.name) for r in processor.query(query)]
        if len(frame_rows) > MAX_SAMPLES:
            raise ValueError("Trace 帧数超过分析上限，请拆分")
        tracks = Counter((row["track_id"], row["name"]) for row in frame_rows)
        selected = tracks.most_common(1)[0][0] if tracks else None
        rows = [row for row in frame_rows if (row["track_id"], row["name"]) == selected]
        warnings = ["使用单一帧标记轨道；未提供帧标记时 FPS 不可计算，系统 CPU 频率不等于应用 CPU 耗时。"]
        if not rows:
            timeline_sql = f"""SELECT s.ts/1e9 AS time_s,s.dur/1e6 AS frame_ms,s.layer_name,s.upid
                FROM actual_frame_timeline_slice s JOIN process p USING(upid)
                WHERE {scope} AND s.dur>0 AND s.surface_frame_token>0 LIMIT 500001"""
            timeline = [dict(time_s=r.time_s, frame_ms=r.frame_ms, layer=r.layer_name, upid=r.upid) for r in processor.query(timeline_sql)]
            if len(timeline) > MAX_SAMPLES:
                raise ValueError("FrameTimeline 样本超过上限")
            layers = Counter((row["upid"], row["layer"]) for row in timeline)
            layer = layers.most_common(1)[0][0] if layers else None
            rows = [row for row in timeline if (row["upid"], row["layer"]) == layer]
            if rows:
                warnings.append("使用 FrameTimeline 单一图层完成耗时（包含 GPU/提交）；其倒数只是吞吐估算，不等于屏幕呈现 FPS。")
        counter_sql = f"""SELECT c.ts/1e9 AS time_s,c.value,t.name FROM counter c
            JOIN process_counter_track t ON t.id=c.track_id JOIN process p USING(upid) WHERE {scope} AND lower(t.name) IN
            ('memory_mb','mem.rss','gpu_ms','gpu_load_pct','cpu_ms','gc_ms','gc_count','cpu_freq_mhz','temperature_c') LIMIT 500001"""
        for row in processor.query(counter_sql):
            if len(rows) >= MAX_SAMPLES:
                raise ValueError("Trace 计数器超过分析上限，请拆分")
            name = str(row.name).lower()
            rows.append({"time_s": row.time_s, "memory_mb" if name == "mem.rss" else name: row.value / 1024**2 if name == "mem.rss" else row.value})
        gc_sql = f"""SELECT s.ts/1e9 AS time_s,s.dur/1e6 AS duration_ms,s.name
            FROM slice s JOIN thread_track t ON t.id=s.track_id JOIN thread th ON th.utid=t.utid
            JOIN process p ON p.upid=th.upid WHERE {scope} AND s.dur>=0
            AND (s.name GLOB '*GC.Collect*' OR s.name GLOB '*GarbageCollect*') LIMIT 10000"""
        gc_events = [dict(time_s=r.time_s, duration_ms=r.duration_ms, name=r.name) for r in processor.query(gc_sql)]
        hot_sql = f"""SELECT s.name,count(*) AS count,sum(s.dur)/1e6 AS total_ms,max(s.dur)/1e6 AS max_ms
            FROM slice s JOIN thread_track t ON t.id=s.track_id JOIN thread th ON th.utid=t.utid
            JOIN process p ON p.upid=th.upid WHERE {scope} AND s.dur>0
            GROUP BY s.name ORDER BY total_ms DESC LIMIT 30"""
        hotspots = [dict(name=r.name, count=r.count, total_ms=r.total_ms, max_ms=r.max_ms) for r in processor.query(hot_sql)]
    if not process_name:
        warnings.append("未指定进程，计数器/热点可能包含系统或其他应用，请补充目标进程。")
    return rows, gc_events, hotspots, warnings


def parse_performance(path, options):
    """作用：自动识别采样、日志、Trace；入参：文件路径与选项；返回：可分析数据结构。"""
    path = Path(path)
    with path.open("rb") as source:
        prefix = source.read(4096)
    warnings, gc_events, hotspots, logs, rows, snapshots = [], [], [], [], [], []
    # 原生 Unity 二进制没有公开稳定的独立解码格式，必须先在 Unity Editor 导出。
    if path.suffix.lower() in (".raw", ".data") and not prefix.lstrip().startswith((b"{", b"[")):
        raise ValueError("识别到 Unity 原生 Profiler；请用 integrations/unity/QualityProfilerExporter.cs 导出 JSON 再导入")
    if path.suffix.lower() in (".pftrace", ".perfetto-trace", ".trace", ".pb") and not prefix.lstrip().startswith((b"{", b"[")):
        rows, gc_events, hotspots, warnings = perfetto_binary(path, options.get("process_name", ""))
        source_format = "perfetto_binary"
    else:
        if path.stat().st_size > 128 * 1024 * 1024:
            raise ValueError("文本文件上限 128 MiB，请拆分；大型 Trace 请使用二进制格式")
        try:
            text = path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            text = path.read_text(encoding="utf-16" if prefix.startswith((b"\xff\xfe", b"\xfe\xff")) else "gb18030")
        stripped = text.lstrip()
        if not stripped:
            raise ValueError("文件为空或只有空白内容")
        if stripped.startswith(("{", "[")):
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                # JSON Lines 运行日志也允许混合普通日志。
                data = None
            if isinstance(data, dict) and "traceEvents" in data:
                rows, gc_events, hotspots, warnings = trace_events(data, options.get("process_name", ""))
                source_format = "trace_json"
            elif isinstance(data, list) or isinstance(data, dict) and "samples" in data:
                rows = data if isinstance(data, list) else data["samples"]
                if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
                    raise ValueError("samples 必须为采样对象数组")
                source_format = "unity_json"
                if isinstance(data, dict):
                    snapshots = data.get("memory_snapshots", [])
                    if not isinstance(snapshots, list) or len(snapshots) > 20:
                        raise ValueError("memory_snapshots 必须为最多 20 次快照的数组")
            else:
                logs, rows = parse_logs(text)
                source_format = "game_log"
                if data is not None:
                    warnings.append("JSON 不包含 samples/traceEvents，仅按日志分析。")
        elif path.suffix.lower() in (".csv", ".tsv") or any(token.strip().strip('"').lower() in {alias for names in ALIASES.values() for alias in names} for token in re.split(r"[,;\t]",text.splitlines()[0])):
            try:
                dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t")
            except csv.Error as error:
                raise ValueError("无法识别 CSV 分隔符，请使用逗号、分号或制表符") from error
            reader = csv.DictReader(io.StringIO(text), dialect=dialect)
            if not any(name.strip().lower() in {alias for names in ALIASES.values() for alias in names} for name in reader.fieldnames or []):
                raise ValueError("CSV 无可识别采样列，请参考数据字段规范")
            rows = list(reader)
            source_format = "profiler_csv"
        else:
            logs, rows = parse_logs(text)
            source_format = "game_log"
        if not any("time_s" in row or "time" in row or "timestamp_s" in row or "elapsed_s" in row for row in rows):
            warnings.append("缺少时间戳，按导入采样间隔生成时间轴；该时间轴属于推算。")
    samples = normalize(rows, options.get("sample_interval_s", 1))
    if options.get("scene"):
        for sample in samples:
            if sample["scene"] == "未标记":
                sample["scene"] = options["scene"]
    if not samples and not logs and not hotspots:
        raise ValueError("未发现支持的采样、帧标记或报错日志，请检查文件和采集开关")
    if samples:
        origin = samples[0]["time_s"]
        for sample in samples:
            sample["time_s"] -= origin
        for event in gc_events:
            event["time_s"] -= origin
    return {"format": source_format, "samples": samples, "logs": logs, "gc_events": gc_events, "snapshots": snapshots,
            "hotspots": hotspots, "warnings": warnings}


def series_stats(samples, key):
    """作用：计算单项指标；入参：采样列表和字段；返回：有效样本统计，缺失返回 None。"""
    values = [sample[key] for sample in samples if sample.get(key) is not None]
    if not values:
        return None
    return {"count": len(values), "mean": statistics.mean(values), "p50": percentile(values,.5), "p95": percentile(values, .95),
            "p99": percentile(values, .99), "max": max(values), "min": min(values)}


def retained_objects(snapshots):
    """作用：定位跨快照保留对象和增长来源；入参：同次运行的 GC 后对象快照；返回：对象候选及证据限制。"""
    if len(snapshots) < 2:
        return []
    mappings = []
    for snapshot in snapshots:
        if not isinstance(snapshot, dict) or not isinstance(snapshot.get("objects"), list) or len(snapshot["objects"]) > 100000:
            raise ValueError("对象快照必须含 objects 数组且每次不超过 100000 项")
        objects = {}
        for obj in snapshot["objects"]:
            if not isinstance(obj, dict) or not isinstance(obj.get("id"), str) or number(obj.get("bytes")) is None:
                raise ValueError("快照对象必须含稳定字符串 id 和非负 bytes")
            if obj["id"] in objects:
                raise ValueError("同次快照存在重复对象 id")
            objects[obj["id"]] = obj
        mappings.append(objects)
    result = []
    for object_id, obj in mappings[-1].items():
        # 仅报告连续后两次快照存活的新增或增长对象，避免把单次临时分配当泄漏。
        if object_id not in mappings[-2]:
            continue
        before = mappings[0].get(object_id, {}).get("bytes", 0)
        growth = obj["bytes"] - before
        if growth > 0:
            stack = obj.get("allocation_stack", [])
            if not isinstance(stack, list) or any(not isinstance(line, str) for line in stack):
                raise ValueError("allocation_stack 必须为字符串数组")
            result.append({"id":object_id,"type":str(obj.get("type","unknown")),"growth_bytes":growth,
                "bytes":obj["bytes"],"allocation_stack":stack[:40],
                "evidence":"同次运行后两次快照存活且相对基线新增/增长；仍需检查持有引用和业务缓存生命周期。"})
    return sorted(result,key=lambda item:-item["growth_bytes"])[:100]


def analyze_performance(path, options):
    """作用：生成性能风险与趋势报告；入参：文件路径、采样配置；返回：JSON 可序列化报告。"""
    data = parse_performance(path, options)
    samples = data.pop("samples")
    retained = retained_objects(data.pop("snapshots"))
    metrics = {key: series_stats(samples, key) for key in ALIASES if key not in ("time_s", "fps")}
    budget = 1000 / options.get("target_fps", 60)
    frames = [sample for sample in samples if sample["frame_ms"] is not None and sample["frame_ms"] > 0]
    janks = [sample for sample in frames if sample["frame_ms"] > budget * 1.5]
    gc_sorted = sorted(data["gc_events"], key=lambda event: event["time_s"])
    gc_starts = [event["time_s"] for event in gc_sorted]
    worst_janks = sorted(janks, key=lambda sample: -sample["frame_ms"])[:100]
    for sample in worst_janks:
        start, end = sample["time_s"], sample["time_s"] + sample["frame_ms"] / 1000
        if gc_sorted:
            # 只关联显式同一 Trace 时钟中的事件，不将不同文件时钟擅自对齐。
            candidates = gc_sorted[max(0, bisect_left(gc_starts, start)-1):bisect_left(gc_starts, end)]
            sample["gc_overlap_ms"] = sum(max(0, min(end,event["time_s"]+event["duration_ms"]/1000)-max(start,event["time_s"])) * 1000 for event in candidates)
    risks = []
    if retained:
        risks.append({"level":"P1","title":"对象快照存在持续保留的增长候选",
            "evidence":f"{len(retained)} 个对象/聚合项，详见保留对象与分配栈",
            "suggestion":"在相同循环多次 GC 后复采，检查静态集合、事件订阅与资源引用链；缓存增长不必然是泄漏。"})
    if frames:
        times = [sample["frame_ms"] for sample in frames]
        metrics["fps_avg"] = 1000 / statistics.mean(times)
        metrics["fps_1pct_low"] = 1000 / statistics.mean(sorted(times, reverse=True)[:max(1, math.ceil(len(times) * .01))])
        metrics["jank_pct"] = len(janks) / len(frames) * 100
        metrics["frame_budget_ms"] = budget
        if janks:
            risks.append({"level": "P0" if max(times) >= 500 else "P1" if metrics["jank_pct"] >= 5 else "P2",
                "title": "卡顿帧超预算", "evidence": f"{len(janks)}/{len(frames)} 样本超过 {budget * 1.5:.2f} ms；最大 {max(times):.2f} ms",
                "suggestion": "在对应时间窗关联 GC、主线程与 GPU，单独关闭特效/降低分辨率复测；帧标记数据需核对呈现间隔。"})
    memory = [sample for sample in samples if sample["memory_mb"] is not None]
    if len(memory) >= 2:
        duration = memory[-1]["time_s"] - memory[0]["time_s"]
        xs, ys = [s["time_s"] for s in memory], [s["memory_mb"] for s in memory]
        mean_x, mean_y = statistics.mean(xs), statistics.mean(ys)
        variance = sum((x - mean_x) ** 2 for x in xs)
        slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys)) / variance * 60 if variance else 0
        metrics["memory_growth_mb"] = ys[-1] - ys[0]
        metrics["memory_slope_mb_min"] = slope
        if len(memory) >= 60 and duration >= 60 and ys[-1] - ys[0] >= 10 and slope >= .5:
            risks.append({"level": "P1", "title": "疑似持续内存增长", "evidence": f"{duration:.1f}s 净增长 {ys[-1]-ys[0]:.1f} MiB，斜率 {slope:.2f} MiB/min",
                "suggestion": "定位此区间及场景切换点，重复相同循环并对比 GC 后基线；使用 Memory Profiler 对象快照和引用链确认泄漏点。"})
    frequencies = [sample for sample in samples if sample["cpu_freq_mhz"] is not None and sample["cpu_freq_mhz"] > 0]
    intervals = []
    if len(frequencies) >= 10:
        baseline = percentile([s["cpu_freq_mhz"] for s in frequencies[:max(5, len(frequencies)//5)]], .9)
        run = []
        for sample in frequencies + [None]:
            if sample and sample["cpu_freq_mhz"] < baseline * .7:
                run.append(sample)
            else:
                if len(run) >= 3 and run[-1]["time_s"] - run[0]["time_s"] >= 2:
                    intervals.append({"start_s": run[0]["time_s"], "end_s": run[-1]["time_s"], "baseline_mhz": baseline})
                run = []
        if intervals:
            risks.append({"level": "P2", "title": "检测到低频区间（降频候选）", "evidence": f"{len(intervals)} 个区间低于起始频率基线 70%",
                "suggestion": "保持同一 CPU 核/集群和持续负载，对齐温度与调度数据；DVFS 节能也会降频，不能仅据此断言热降频。"})
    duration = max((sample["time_s"] for sample in samples), default=0)
    gc_count = sum(sample["gc_count"] or 0 for sample in samples) if metrics["gc_count"] else len(data["gc_events"])
    gc_total = sum(event["duration_ms"] for event in data["gc_events"]) if data["gc_events"] else sum(s["gc_ms"] or 0 for s in samples)
    metrics["gc_total_count"] = gc_count if metrics["gc_count"] or data["gc_events"] else None
    metrics["gc_total_ms"] = gc_total if metrics["gc_ms"] or data["gc_events"] else None
    metrics["gc_per_min"] = gc_count * 60 / duration if duration and metrics["gc_total_count"] is not None else None
    if gc_total > 0:
        risks.append({"level": "P1" if gc_total > max(100, duration * 10) else "P2", "title": "GC 停顿需关注",
            "evidence": f"累计 {gc_total:.2f} ms；次数 {metrics['gc_total_count'] if metrics['gc_total_count'] is not None else '未采集'}",
            "suggestion": "对齐 GC 与卡顿帧，检查临时集合、字符串拼接、装箱与对象池；gc_count 约定为每个采样间隔增量。"})
    if data["logs"]:
        errors = sum(group["count"] for group in data["logs"] if group["severity"] == "error")
        if errors:
            risks.append({"level": "P1", "title": "运行日志存在异常", "evidence": f"{errors} 次错误，{len(data['logs'])} 个分类/场景组",
                "suggestion": "按首发场景和堆栈定位，先修复重复异常，复测是否引发分配和卡顿。"})
    missing = [key for key in ("frame_ms", "cpu_ms", "gpu_ms", "gpu_load_pct", "memory_mb", "gc_ms") if metrics[key] is None]
    # 每桶保留帧尖峰和末次内存，趋势不会因简单抽点完全隐藏卡顿。
    trend = []
    step = max(1, math.ceil(len(samples) / 600))
    for start in range(0, len(samples), step):
        bucket = samples[start:start+step]
        point = {"time_s": bucket[-1]["time_s"], "scene": bucket[-1]["scene"]}
        for key in ("frame_ms", "cpu_ms", "gpu_ms", "memory_mb", "gpu_load_pct", "cpu_freq_mhz", "gc_ms"):
            values = [sample[key] for sample in bucket if sample[key] is not None]
            point[key] = (values[-1] if key == "memory_mb" else max(values)) if values else None
        trend.append(point)
    return {**data, "kind": "performance", "metrics": metrics, "risks": risks, "trend": trend,
        "sample_count": len(samples), "duration_s": duration, "missing_metrics": missing,
        "jank_frames": worst_janks, "low_frequency_intervals": intervals[:100], "retained_objects": retained,
        "notes": ["缺失与不支持的指标显示为未采集；GC 次数为采样间隔增量。", "CSV 的 FPS 反推帧耗时属于估算，不能替代逐帧采样。",
                  "趋势图每桶显示耗时峰值、内存末值；仅凭趋势无法证明对象泄漏。"], "metadata": options}
