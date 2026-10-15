"""APK 目录、大小、重复内容与构建证据校验。逐个流式解压，不执行包内代码。"""

import hashlib
import re
import struct
import zipfile
from collections import defaultdict
from pathlib import Path, PurePosixPath

MIB = 1024 * 1024
DEFAULT_RULES = {
    "apk_max_mb": 500, "image_max_mb": 2, "single_file_max_mb": 50,
    "image_max_dimension": 4096, "so_max_count": 40, "shader_variants_max": 20000,
    "atlas_min_fill_pct": 65,
}
IMAGES = {".png", ".jpg", ".jpeg", ".webp", ".ktx", ".ktx2", ".astc", ".pvr"}


def validate_rules(rules):
    """作用：校验用户质量红线；入参：规则字典；返回：合并默认值后的规则。"""
    if not isinstance(rules, dict) or set(rules) - set(DEFAULT_RULES):
        raise ValueError("规则包含未知字段")
    result = {**DEFAULT_RULES, **rules}
    for key, value in result.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 < value <= 1_000_000:
            raise ValueError(f"规则 {key} 必须为正数且不超过 1000000")
    if result["atlas_min_fill_pct"] > 100:
        raise ValueError("图集占用率红线必须不超过 100%")
    return result


def category(name):
    """作用：按 APK 路径和扩展名分类；入参：资源路径；返回：互斥分类名称。"""
    path = PurePosixPath(name.lower())
    suffix = path.suffix
    if suffix == ".dex":
        return "dex"
    if suffix == ".so":
        return "so"
    if suffix in (".mp3", ".ogg", ".wav", ".aac", ".bank", ".wem"):
        return "audio"
    if suffix in (".mp4", ".webm", ".mov", ".avi"):
        return "video"
    if "atlas" in path.name or suffix in (".spriteatlas", ".spriteatlasv2"):
        return "atlas"
    if suffix in IMAGES:
        return "images"
    if name.lower().startswith(("assets/", "res/")) or path.name == "resources.arsc":
        return "resources"
    return "other"


def image_size(header):
    """作用：读取 PNG/JPEG/WebP 尺寸；入参：前 256 KiB 文件字节；返回：宽高数组或 None。"""
    if header.startswith(b"\x89PNG\r\n\x1a\n") and len(header) >= 24:
        return list(struct.unpack(">II", header[16:24]))
    if header.startswith(b"\x13\xab\xa1\x5c") and len(header) >= 16:
        return [int.from_bytes(header[7:10],"little"),int.from_bytes(header[10:13],"little")]
    if header.startswith(b"\xabKTX 11\xbb\r\n\x1a\n") and len(header) >= 44:
        endian = "<" if header[12:16] == b"\x01\x02\x03\x04" else ">"
        return list(struct.unpack(endian+"II",header[36:44]))
    if header.startswith(b"\xabKTX 20\xbb\r\n\x1a\n") and len(header) >= 28:
        return list(struct.unpack("<II",header[20:28]))
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP" and len(header) >= 30:
        if header[12:16] == b"VP8X":
            return [int.from_bytes(header[24:27], "little") + 1, int.from_bytes(header[27:30], "little") + 1]
        if header[12:16] == b"VP8 " and header[23:26] == b"\x9d\x01\x2a":
            return [int.from_bytes(header[26:28], "little") & 16383, int.from_bytes(header[28:30], "little") & 16383]
        if header[12:16] == b"VP8L" and header[20] == 0x2f:
            value = int.from_bytes(header[21:25],"little")
            return [(value&16383)+1,((value>>14)&16383)+1]
    if header.startswith(b"\xff\xd8"):
        offset = 2
        while offset + 4 < len(header):
            if header[offset] != 255:
                offset += 1
                continue
            marker = header[offset + 1]
            if marker in (0xD8, 0xD9):
                offset += 2
                continue
            size = int.from_bytes(header[offset+2:offset+4], "big")
            if marker in (0xC0, 0xC1, 0xC2, 0xC3) and offset + 9 <= len(header):
                height, width = struct.unpack(">HH", header[offset+5:offset+9])
                return [width, height]
            if size < 2:
                break
            offset += size + 2
    return None


def validate_evidence(evidence):
    """作用：校验可选构建证据；入参：JSON 对象；返回：规范证据，拒绝不完整的权威结论。"""
    if not isinstance(evidence, dict):
        raise ValueError("构建证据必须为 JSON 对象")
    if evidence and not isinstance(evidence.get("apk_sha256"), str):
        raise ValueError("构建证据必须包含 apk_sha256，与本次 APK 完全一致")
    if evidence.get("reference_graph_complete") is True:
        if not isinstance(evidence.get("referenced_paths"), list) or not isinstance(evidence.get("reference_scope_paths"), list):
            raise ValueError("完整引用图需要 referenced_paths 与 reference_scope_paths 数组")
    if not isinstance(evidence.get("atlases", []), list):
        raise ValueError("atlases 必须为数组")
    for atlas in evidence.get("atlases", []):
        if not isinstance(atlas, dict) or not isinstance(atlas.get("path"), str):
            raise ValueError("图集证据需要 path 字段")
        values = [atlas.get(key) for key in ("width", "height", "used_area")]
        if any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in values):
            raise ValueError("图集 width/height/used_area 必须为数字")
        width, height, area = values
        if width <= 0 or height <= 0 or area < 0 or area > width * height:
            raise ValueError("图集面积或尺寸无效")
    variants = evidence.get("shader_variants")
    if variants is not None and (isinstance(variants, bool) or not isinstance(variants, int) or variants < 0):
        raise ValueError("shader_variants 必须为非负整数")
    for key in ("referenced_paths", "reference_scope_paths", "dynamic_paths"):
        if key in evidence and (not isinstance(evidence[key], list) or any(not isinstance(v, str) for v in evidence[key])):
            raise ValueError(f"{key} 必须为字符串数组")
    return evidence


def analyze_apk(path, options):
    """作用：流式解包并输出 APK 自检报告；入参：APK 路径和规则/证据；返回：文件树、占比和违规建议。"""
    path = Path(path)
    rules = validate_rules(options.get("rules", {}))
    evidence = validate_evidence(options.get("build_evidence", {}))
    apk_hash = hash_file(path)
    if evidence and evidence["apk_sha256"].lower() != apk_hash:
        raise ValueError("构建证据的 APK SHA-256 不匹配，禁止据此报告未引用/Shader/图集结论")
    if not zipfile.is_zipfile(path):
        raise ValueError("文件不是有效 APK/ZIP")
    entries, risks, hashes = [], [], defaultdict(list)
    groups = {name: {"bytes": 0, "compressed_bytes": 0, "count": 0} for name in ("dex", "so", "resources", "audio", "atlas", "video", "images", "other")}
    tree = defaultdict(lambda: {"bytes": 0, "count": 0})
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        if len(members) > 60000:
            raise ValueError("压缩包条目超过 60000 个")
        if sum(member.file_size for member in members) > 4 * 1024**3:
            raise ValueError("解压总量超过 4 GiB")
        if not any(member.filename == "AndroidManifest.xml" for member in members):
            raise ValueError("缺少 AndroidManifest.xml，非有效 APK 结构")
        paths = set()
        for member in members:
            name = member.filename
            parts = PurePosixPath(name).parts
            if "\\" in name or name.startswith("/") or ".." in parts or re.match(r"^[a-zA-Z]:", name):
                raise ValueError("APK 包含不安全路径")
            if name in paths:
                raise ValueError("APK 包含同名重复条目，拒绝歧义结构")
            paths.add(name)
            if member.is_dir():
                continue
            if member.flag_bits & 1 or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("不支持加密或符号链接条目")
            if member.file_size > 1024**3 or member.file_size > max(1, member.compress_size) * 1000:
                raise ValueError("条目超过 1 GiB 或压缩比异常")
            digest, header, consumed = hashlib.sha256(), bytearray(), 0
            # 不落地包内路径；逐块解压并读取至 EOF，zipfile 同时验证 CRC。
            with archive.open(member) as source:
                while True:
                    chunk = source.read(1024 * 1024)
                    if not chunk:
                        break
                    consumed += len(chunk)
                    if consumed > member.file_size or consumed > 1024**3:
                        raise ValueError("条目实际解压量异常")
                    digest.update(chunk)
                    if len(header) < 256 * 1024:
                        header.extend(chunk[:256 * 1024 - len(header)])
            kind = category(name)
            entry = {"path": name, "category": kind, "bytes": member.file_size, "compressed_bytes": member.compress_size,
                "compression": "stored" if member.compress_type == zipfile.ZIP_STORED else "compressed",
                "sha256": digest.hexdigest(), "dimensions": image_size(bytes(header)) if PurePosixPath(name.lower()).suffix in IMAGES else None}
            entries.append(entry)
            if member.file_size:
                hashes[(entry["sha256"], member.file_size)].append(name)
            groups[kind]["bytes"] += member.file_size
            groups[kind]["compressed_bytes"] += member.compress_size
            groups[kind]["count"] += 1
            for depth in range(1, len(parts)):
                directory = "/".join(parts[:depth]) + "/"
                tree[directory]["bytes"] += member.file_size
                tree[directory]["count"] += 1
            if member.file_size > rules["single_file_max_mb"] * MIB:
                risks.append(finding("P1", "超大单文件", name, member.file_size, "single_file_max_mb", rules,
                    "检查 AssetBundle 拆分，音视频按需下载；避免启动阶段读取大文件。"))
            if PurePosixPath(name.lower()).suffix in IMAGES and member.file_size > rules["image_max_mb"] * MIB:
                risks.append(finding("P1", "图片文件大小超限", name, member.file_size, "image_max_mb", rules,
                    "检查纹理平台压缩、分辨率和透明通道；文件体积不等于运行时显存。"))
            if entry["dimensions"] and max(entry["dimensions"]) > rules["image_max_dimension"]:
                risks.append(finding("P1", "图片尺寸超限", name, max(entry["dimensions"]), "image_max_dimension", rules,
                    "降低导入最大尺寸，按 UI/场景使用距离设置纹理平台覆盖。"))
            # native 库和 resources.arsc 可能为 mmap/安装要求而 Stored，不作为压缩违规。
            if member.compress_type == zipfile.ZIP_STORED and member.file_size > MIB and PurePosixPath(name).suffix.lower() in (".txt", ".json", ".xml", ".csv"):
                risks.append({"level": "P2", "title": "可压缩文本未压缩", "path": name,
                    "evidence": f"Stored，{member.file_size} bytes", "suggestion": "确认运行时无需 mmap/随机读取后启用压缩。"})
    total = sum(entry["bytes"] for entry in entries)
    for group in groups.values():
        group["percentage"] = group["bytes"] / total * 100 if total else 0
    if path.stat().st_size > rules["apk_max_mb"] * MIB:
        risks.append(finding("P0", "APK 总大小超限", path.name, path.stat().st_size, "apk_max_mb", rules,
            "清理重复/调试资源，按 ABI 分包并拆分按需资源。"))
    if groups["so"]["count"] > rules["so_max_count"]:
        risks.append(finding("P1", "原生库数量超限", "lib/", groups["so"]["count"], "so_max_count", rules,
            "核对 SDK 重复依赖与 ABI；按 ABI 比较，不可删除启动所需原生库。"))
    duplicates = [{"paths": names, "bytes_each": size, "potential_saving_bytes": size * (len(names)-1)}
                  for (_, size), names in hashes.items() if len(names) > 1]
    duplicates.sort(key=lambda item: -item["potential_saving_bytes"])
    if duplicates:
        risks.append({"level": "P2", "title": "内容完全相同的重复文件", "evidence": f"{len(duplicates)} 组 SHA-256 和大小一致",
            "suggestion": "排除多 ABI 必需副本后共享资源；仅为潜在解压大小节省，不能直接等同 APK 下载节省。"})
    checks = {"references": "not_available", "shader_variants": "not_available", "atlas_fill": "not_available"}
    unused = []
    if evidence.get("reference_graph_complete") is True:
        referenced = set(evidence["referenced_paths"]) | set(evidence.get("dynamic_paths", []))
        scope = set(evidence["reference_scope_paths"])
        checks["references"] = "build_evidence"
        unused = [entry["path"] for entry in entries if entry["path"] in scope and entry["path"] not in referenced]
        for name in unused:
            risks.append({"level": "P2", "title": "构建引用图中的未引用资源候选", "path": name,
                "evidence": "在本次构建完整性声明的检查范围内，未在静态/动态引用清单中出现",
                "suggestion": "复核 Resources.Load、反射、远端清单和动态路径；验证无运行依赖后再清理。"})
    variants = evidence.get("shader_variants")
    if variants is not None:
        checks["shader_variants"] = "build_evidence"
        if variants > rules["shader_variants_max"]:
            risks.append(finding("P1", "Shader 变体超限", "build-report", variants, "shader_variants_max", rules,
                "使用本次构建的 Shader 变体报告定位关键词组合，按实际质量档位剔除未用变体。"))
    atlases = []
    for atlas in evidence.get("atlases", []):
        fill = atlas["used_area"] / (atlas["width"] * atlas["height"]) * 100
        atlases.append({**atlas, "fill_pct": fill})
        if fill < rules["atlas_min_fill_pct"]:
            risks.append({"level": "P2", "title": "图集空闲比例过高", "path": atlas["path"],
                "evidence": f"构建证据占用率 {fill:.2f}% < {rules['atlas_min_fill_pct']}%",
                "suggestion": "按共同加载生命周期重新分组，检查 padding 与打包尺寸；占用率只是碎片代理指标。"})
    if atlases:
        checks["atlas_fill"] = "build_evidence"
    return {"kind": "apk", "format": "apk_zip", "apk_sha256": apk_hash, "apk_bytes": path.stat().st_size,
        "uncompressed_bytes": total, "file_count": len(entries), "categories": groups,
        "directory_tree": [{"path": key, **value} for key, value in sorted(tree.items())],
        "files": sorted(entries, key=lambda entry: -entry["bytes"]), "duplicates": duplicates,
        "unused_candidates": unused, "atlases": atlases, "shader_variants": variants, "rules": rules,
        "checks": checks, "risks": risks, "warnings": ["分类基于路径/扩展名；Unity 序列化包内部纹理/音频需要额外构建资源清单。",
            "引用关系、Shader 变体、图集占用仅在上传匹配 APK 哈希的构建证据后判定；缺少证据不视为通过。",
            "原生库、resources.arsc 等 Stored 条目可能为平台要求，不自动建议压缩。"], "metadata": options}


def hash_file(path):
    """作用：流式计算文件 SHA-256；入参：Path；返回：十六进制摘要。"""
    digest = hashlib.sha256()
    with Path(path).open("rb") as source:
        while True:
            chunk = source.read(MIB)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def finding(level, title, path, actual, rule, rules, suggestion):
    """作用：构造质量红线违规；入参：等级、标题、路径、数值和规则；返回：可展示违规对象。"""
    labels = {"apk_max_mb":"APK 大小","image_max_mb":"图片大小","single_file_max_mb":"单文件大小",
              "image_max_dimension":"图片最长边","so_max_count":"SO 文件数","shader_variants_max":"Shader 变体数"}
    value = actual / MIB if rule.endswith("_mb") else actual
    unit = "MiB" if rule.endswith("_mb") else "px" if rule == "image_max_dimension" else "项"
    return {"level": level, "title": title, "path": path, "actual": actual, "rule": rule,
            "limit": rules[rule], "evidence": f"{labels.get(rule,rule)} 实测 {value:.2f} {unit} > 红线 {rules[rule]} {unit}", "suggestion": suggestion}
