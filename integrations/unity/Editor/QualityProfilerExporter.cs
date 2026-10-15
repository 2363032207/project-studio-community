#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.Profiling;
using UnityEditorInternal;
using UnityEngine;

/// <summary>将 Unity Profiler 的原生记录转换为质量工具可读 JSON；建议 Unity 2022.3 LTS 或 Unity 6。</summary>
public static class QualityProfilerExporter
{
    [Serializable]
    private sealed class Sample
    {
        public double time_s;
        public float frame_ms;
        public float cpu_ms = -1;
        public float gpu_ms = -1;
        public float memory_mb = -1;
        public float gc_ms;
        public int gc_count;
        public string scene = "未标记";
    }

    [Serializable]
    private sealed class Export
    {
        public string format = "unity-profiler-export-v1";
        public string unity_version = Application.unityVersion;
        public List<Sample> samples = new List<Sample>();
    }

    /// <summary>作用：从菜单选择原生记录并导出；入参：无；返回：无，在用户选择的目录写入 JSON。</summary>
    [MenuItem("Tools/Quality/Export Profiler Record to JSON")]
    public static void ChooseAndExport()
    {
        string input = EditorUtility.OpenFilePanel("选择 Unity Profiler .raw 或 .data", "", "");
        if (string.IsNullOrEmpty(input)) return;
        string output = EditorUtility.SaveFilePanel("导出性能采样 JSON", "", "profiler-samples", "json");
        if (!string.IsNullOrEmpty(output)) ExportFile(input, output);
    }

    /// <summary>作用：可供 Unity -executeMethod 调用的命令入口；入参：命令行 -qualityInput/-qualityOutput；返回：无。</summary>
    public static void BatchExport()
    {
        string[] args = Environment.GetCommandLineArgs();
        string input = Argument(args, "-qualityInput");
        string output = Argument(args, "-qualityOutput");
        ExportFile(input, output);
    }

    /// <summary>作用：读取命令行参数；入参：参数数组、参数名；返回：参数值，缺少时抛出异常。</summary>
    private static string Argument(string[] args, string key)
    {
        int index = Array.IndexOf(args, key);
        if (index < 0 || index + 1 >= args.Length) throw new ArgumentException("缺少参数 " + key);
        return args[index + 1];
    }

    /// <summary>作用：通过 Unity 官方帧数据接口转换；入参：原生记录路径、输出路径；返回：无，写入逐帧 JSON。</summary>
    public static void ExportFile(string input, string output)
    {
        if (!File.Exists(input)) throw new FileNotFoundException("Profiler 文件不存在", input);
        if (!ProfilerDriver.LoadProfile(input, false)) throw new InvalidOperationException("Unity 无法载入 Profiler 文件，请使用相同版本编辑器");
        var result = new Export();
        double firstStart = -1;
        for (int frame = ProfilerDriver.firstFrameIndex; frame <= ProfilerDriver.lastFrameIndex; frame++)
        {
            using (RawFrameDataView data = ProfilerDriver.GetRawFrameDataView(frame, 0))
            {
                if (!data.valid) continue;
                if (firstStart < 0) firstStart = data.frameStartTimeMs;
                var sample = new Sample { time_s = (data.frameStartTimeMs - firstStart) / 1000.0,
                    frame_ms = data.frameTimeMs, gpu_ms = data.frameGpuTimeMs > 0 ? data.frameGpuTimeMs : -1 };
                for (int index = 0; index < data.sampleCount; index++)
                {
                    string name = data.GetSampleName(index);
                    // 只统计明确的完整 GC 标记；避免把 GC.Alloc 分配计数当回收次数。
                    if (name == "GC.Collect" || name == "GarbageCollect")
                    {
                        sample.gc_ms += data.GetSampleTimeMs(index);
                        sample.gc_count++;
                    }
                    if (name == "PlayerLoop") sample.cpu_ms = data.GetSampleTimeMs(index);
                }
                // Unity 6 的计数器存在且本帧有效时才读内存，避免将缺失当成零。
#if UNITY_6000_0_OR_NEWER
                int memoryMarker = data.GetMarkerId("Total Used Memory");
                if (memoryMarker != FrameDataView.invalidMarkerId && data.HasCounterValue(memoryMarker))
                    sample.memory_mb = data.GetCounterValueAsLong(memoryMarker) / (1024f * 1024f);
#endif
                // 未采集的 GPU/内存保留 -1，由分析器显示“未采集”。
                result.samples.Add(sample);
            }
        }
        if (result.samples.Count == 0) throw new InvalidOperationException("记录没有可读取帧");
        File.WriteAllText(output, JsonUtility.ToJson(result, true));
        Debug.Log("性能记录已导出：" + result.samples.Count + " 帧");
    }
}
#endif
