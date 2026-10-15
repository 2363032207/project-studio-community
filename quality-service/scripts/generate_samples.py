"""生成完全虚构的本地演示数据，不使用真实游戏或用户数据。"""

import csv
import hashlib
import json
import random
import struct
import sys
import zipfile
import zlib
from pathlib import Path


def png(width, height):
    """作用：构造有效的单色 PNG；入参：宽高；返回：PNG 字节。"""
    def chunk(kind, data):
        """作用：封装 PNG 数据块；入参：类型和正文；返回：含 CRC 的块字节。"""
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    raw = (b"\0" + b"\x48\x67\xc8" * width) * height
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def generate(destination):
    """作用：生成基线/优化采样、日志、Trace 与 APK；入参：输出目录；返回：生成文件路径列表。"""
    root = Path(destination)
    root.mkdir(parents=True, exist_ok=True)
    fields = ["time_s", "frame_ms", "cpu_ms", "gpu_ms", "gpu_load_pct", "memory_mb", "gc_count", "gc_ms", "cpu_freq_mhz", "temperature_c", "scene"]
    for suffix, optimized in (("baseline", False), ("candidate", True)):
        with (root / f"performance-{suffix}.csv").open("w", newline="", encoding="utf-8") as output:
            writer = csv.DictWriter(output, fieldnames=fields)
            writer.writeheader()
            for second in range(120):
                writer.writerow(dict(zip(fields, [second, 14 if optimized else (120 if second % 11 == 0 else 20), 8 if optimized else 15,
                    9 if optimized else 17, 55 if optimized else 93, 200 + second * (.005 if optimized else .3),
                    1 if second % 11 == 0 else 0, 2 if optimized and second % 11 == 0 else 25 if second % 11 == 0 else 0,
                    2200 if second < 70 or optimized else 1200, 35 + second * .05, "DemoArena"])))
    (root / "game-runtime.txt").write_text("Scene=DemoArena\n[ERROR] NullReferenceException: demo target missing\n  at Demo.Arena.Update() (at Arena.cs:42)\n[ERROR] NullReferenceException: demo target missing\n  at Demo.Arena.Update() (at Arena.cs:42)\n[WARNING] texture streaming budget\nscene=DemoLobby\n[ERROR] TimeoutException: demo request\n  at Demo.Network.Load()\n", encoding="utf-8")
    events = [{"ph":"M","name":"process_name","pid":1,"args":{"name":"com.example.game"}}]
    for frame in range(100):
        events.append({"ph":"X","name":"PlayerLoop","pid":1,"tid":1,"ts":frame*16667,"dur":60000 if frame==30 else 15000})
    (root / "demo-trace.json").write_text(json.dumps({"traceEvents":events}), encoding="utf-8")
    with zipfile.ZipFile(root / "demo-game.apk", "w", compression=zipfile.ZIP_DEFLATED) as package:
        package.writestr("AndroidManifest.xml", '<manifest package="com.example.game"/>')
        package.writestr("classes.dex", b"dex\n035\0demo-not-executable")
        package.writestr("lib/arm64-v8a/libdemo.so", b"demo-placeholder-not-executable")
        image = png(64, 64)
        package.writestr("res/drawable/icon.png", image)
        package.writestr("assets/copy/icon.png", image)
        package.writestr("assets/atlas/demo-atlas.png", png(64,32))
        package.writestr("assets/large.png", png(8192,1))
        package.writestr("assets/config/unused.txt", "demo-unused")
        package.writestr("assets/config/large.json", json.dumps({"demo":"x"*(1024*1024+20)}), compress_type=zipfile.ZIP_STORED)
        package.writestr("assets/audio/demo.ogg", random.Random(7).randbytes(1024))
    digest = hashlib.sha256((root / "demo-game.apk").read_bytes()).hexdigest()
    evidence = {"apk_sha256":digest,"reference_graph_complete":True,"reference_scope_paths":["assets/config/unused.txt"],
        "referenced_paths":[],"dynamic_paths":[],"shader_variants":30000,
        "atlases":[{"path":"assets/atlas/demo-atlas.png","width":64,"height":32,"used_area":500}]}
    (root / "build-evidence.json").write_text(json.dumps(evidence,indent=2), encoding="utf-8")
    (root / "apk-options.json").write_text(json.dumps({"build_evidence":evidence}), encoding="utf-8")
    return list(root.iterdir())


if __name__ == "__main__":
    for path in generate(sys.argv[1] if len(sys.argv)>1 else "data/samples"):
        print(path)
