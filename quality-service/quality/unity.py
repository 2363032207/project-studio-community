"""在用户明确配置的本地 Unity Editor 中转换原生 Profiler 记录。"""

import os
import subprocess
from pathlib import Path


def convert_native(path):
    """作用：使用可信 Unity 工程中的导出器转换；入参：原生路径；返回：导出 JSON 路径，未配置返回原路径。"""
    editor, project = os.environ.get("QUALITY_UNITY_EDITOR"), os.environ.get("QUALITY_UNITY_PROJECT")
    if not editor or not project:
        return path
    if not Path(editor).is_file() or not (Path(project)/"Assets/Editor/QualityProfilerExporter.cs").is_file():
        raise ValueError("Unity 转换配置无效：请确认编辑器路径和 Assets/Editor/QualityProfilerExporter.cs")
    output = Path(path).with_suffix(".converted.json")
    log = Path(path).with_suffix(".unity-conversion.log")
    result = subprocess.run([editor,"-batchmode","-quit","-projectPath",project,"-executeMethod","QualityProfilerExporter.BatchExport",
        "-qualityInput",str(Path(path).resolve()),"-qualityOutput",str(output.resolve()),"-logFile",str(log.resolve())],
        stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=120)
    if result.returncode or not output.is_file():
        raise ValueError("Unity 转换失败，请检查 Unity 许可证、相同编辑器版本和转换日志")
    if output.stat().st_size > 128*1024**2:
        raise ValueError("Unity 导出超过文本分析上限，请裁剪原生记录")
    return output
