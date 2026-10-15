"""用真实文件字节验证指标口径、包体校验与安全边界。"""

import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from quality.apk import analyze_apk, hash_file, image_size, validate_rules
from quality.performance import analyze_performance
from quality.reports import comparison, html_report
from quality.server import validate_options
from quality.storage import Store


class AnalysisTests(unittest.TestCase):
    """使用隔离临时目录，不读取用户原始数据。"""

    def setUp(self):
        """作用：准备临时目录；入参：无；返回：无。"""
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        """作用：清理本测试创建的临时文件；入参：无；返回：无。"""
        self.temp.cleanup()

    def perf(self, rows):
        """作用：分析标准 JSON 夹具；入参：采样行；返回：性能报告。"""
        path = self.root / "capture.json"
        path.write_text(json.dumps({"samples": rows}), encoding="utf-8")
        return analyze_performance(path, {"target_fps":60,"sample_interval_s":1})

    def apk(self, extras=None, options=None):
        """作用：生成最小 APK 结构；入参：附加条目和规则；返回：APK 报告。"""
        path = self.root / "demo.apk"
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr("AndroidManifest.xml", "<manifest/>")
            for name, value in (extras or {}).items():
                archive.writestr(name, value)
        return analyze_apk(path, options or {})

    def test_frame_tail_and_missing_gpu(self):
        """作用：验证帧长尾和不支持的 GPU；入参：无；返回：断言结果。"""
        report = self.perf([{"time_s":i,"frame_ms":100 if i==99 else 10,"gpu_ms":-1} for i in range(100)])
        self.assertAlmostEqual(report["metrics"]["fps_avg"], 1000/10.9)
        self.assertEqual(report["metrics"]["fps_1pct_low"],10)
        self.assertEqual(report["metrics"]["jank_pct"],1)
        self.assertIsNone(report["metrics"]["gpu_ms"])
        self.assertIsNone(report["metrics"]["gc_total_count"])

    def test_memory_and_low_frequency_are_candidates(self):
        """作用：验证持续增长和低频候选而非确定泄漏；入参：无；返回：断言结果。"""
        report=self.perf([{"time_s":i,"memory_mb":100+i*.3,"cpu_freq_mhz":2000 if i<60 else 1000} for i in range(100)])
        titles=[risk["title"] for risk in report["risks"]]
        self.assertIn("疑似持续内存增长", titles)
        self.assertIn("检测到低频区间（降频候选）", titles)
        self.assertAlmostEqual(report["metrics"]["memory_slope_mb_min"],18)
        short=self.perf([{"time_s":i/100,"memory_mb":100+i} for i in range(100)])
        self.assertFalse(any("内存增长" in risk["title"] for risk in short["risks"]))

    def test_log_stack_scene_and_classification(self):
        """作用：验证日志分类、聚合和堆栈；入参：无；返回：断言结果。"""
        path=self.root/"runtime.txt"
        path.write_text("scene=A\nERROR NullReferenceException id=1\n at Demo.Update()\nERROR NullReferenceException id=2\n at Demo.Update()\nscene=B\nWARNING texture\n", encoding="utf-8")
        report=analyze_performance(path,{})
        self.assertEqual(report["logs"][0]["count"],2)
        self.assertEqual(report["logs"][0]["scene"],"A")
        self.assertEqual(report["logs"][0]["type"],"NullReferenceException")
        self.assertEqual(report["logs"][0]["stack"],[" at Demo.Update()"," at Demo.Update()"])
        self.assertEqual(len(report["logs"]),2)

    def test_trace_single_track_and_gc(self):
        """作用：验证嵌套帧标记不重复统计且 GC 可定位；入参：无；返回：断言结果。"""
        events=[]
        for index in range(10):
            events.extend([{"ph":"X","name":"PlayerLoop","ts":index*16667,"dur":16000,"pid":1,"tid":1},
                {"ph":"X","name":"Frame","ts":index*16667,"dur":5000,"pid":1,"tid":2}])
        events.append({"ph":"X","name":"GC.Collect","ts":50000,"dur":5000,"pid":1,"tid":1})
        path=self.root/"trace.json"
        path.write_text(json.dumps({"traceEvents":events}))
        report=analyze_performance(path,{})
        self.assertEqual(report["sample_count"],10)
        self.assertEqual(report["metrics"]["gc_total_count"],1)
        self.assertEqual(report["metrics"]["gc_total_ms"],5)

    def test_empty_and_unsupported_native_files(self):
        """作用：验证空文件和原生 .raw 不能误报成功；入参：无；返回：断言结果。"""
        for name, content in (("empty.txt",b"   "),("unity.raw",b"\x00\x01binary")):
            path=self.root/name
            path.write_bytes(content)
            with self.assertRaises(ValueError):
                analyze_performance(path,{})

    def test_csv_decimal_and_unsupported(self):
        """作用：验证 CSV 数值和不支持哨兵；入参：无；返回：断言结果。"""
        path=self.root/"samples.csv"
        path.write_text("time_s;frame_ms;gpu_ms;gpu_supported\n0;16;20;false\n1;32;-1;false\n")
        report=analyze_performance(path,{})
        self.assertEqual(report["format"],"profiler_csv")
        self.assertIsNone(report["metrics"]["gpu_ms"])

    def test_structured_logs_preserve_scene_time_stack(self):
        """作用：验证 JSON Lines 日志的场景、时间和栈；入参：无；返回：断言结果。"""
        path=self.root/"structured.log"
        lines=[{"level":"error","scene":"DemoArena","timestamp":"2026-01-01T12:00:00Z",
                "message":"TimeoutException request failed","stack":["Demo.Network.Fetch()"]},
               {"level":"warning","scene":"DemoLobby","message":"streaming budget"}]
        path.write_text('\n'.join(json.dumps(line) for line in lines),encoding="utf-8")
        report=analyze_performance(path,{})
        self.assertEqual(report["logs"][0]["type"],"TimeoutException")
        self.assertEqual(report["logs"][0]["scene"],"DemoArena")
        self.assertEqual(report["logs"][0]["first_time"],"2026-01-01T12:00:00Z")
        self.assertEqual(report["logs"][0]["stack"],["Demo.Network.Fetch()"])

    def test_log_with_commas_is_not_misdetected_as_csv(self):
        """作用：验证含逗号的普通日志不会误识别为采样 CSV；入参：无；返回：断言结果。"""
        path=self.root/"commas.log"
        path.write_text("game build, development\nERROR TimeoutException: retry failed\n",encoding="utf-8")
        report=analyze_performance(path,{})
        self.assertEqual(report["format"],"game_log")
        self.assertEqual(report["logs"][0]["type"],"TimeoutException")

    def test_apk_duplicates_and_missing_evidence(self):
        """作用：验证 SHA-256 去重与无证据不判通过；入参：无；返回：断言结果。"""
        report=self.apk({"res/a.png":b"same","res/b.png":b"same","lib/arm64/libdemo.so":b"native"})
        self.assertEqual(len(report["duplicates"]),1)
        self.assertEqual(report["duplicates"][0]["potential_saving_bytes"],4)
        self.assertEqual(report["checks"]["references"],"not_available")
        self.assertEqual(report["unused_candidates"],[])
        self.assertAlmostEqual(sum(group["percentage"] for group in report["categories"].values()),100)

    def test_apk_rule_size_and_dimension(self):
        """作用：验证图片尺寸和规则红线；入参：无；返回：断言结果。"""
        import struct
        header=b"\x89PNG\r\n\x1a\n"+b"0"*8+struct.pack(">II",8192,4096)
        report=self.apk({"res/huge.png":header},{"rules":{"image_max_dimension":4096,"apk_max_mb":.00001}})
        self.assertTrue(any(risk["title"]=="图片尺寸超限" for risk in report["risks"]))
        self.assertTrue(any(risk["level"]=="P0" for risk in report["risks"]))
        self.assertEqual(image_size(header),[8192,4096])

    def test_zip_path_and_bomb_rejected(self):
        """作用：验证恶意路径与高压缩比被拒绝；入参：无；返回：断言结果。"""
        with self.assertRaisesRegex(ValueError,"不安全路径"):
            self.apk({"../escape.txt":b"x"})
        path=self.root/"bomb.apk"
        with zipfile.ZipFile(path,"w",compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("AndroidManifest.xml", "<manifest/>")
            archive.writestr("assets/bomb",b"x"*(4*1024**2))
        with self.assertRaisesRegex(ValueError,"压缩比异常"):
            analyze_apk(path,{})

    def test_build_evidence_must_match_apk(self):
        """作用：验证外部引用证据与包哈希绑定；入参：无；返回：断言结果。"""
        self.apk({"assets/unused.txt":b"demo"})
        path=self.root/"demo.apk"
        evidence={"apk_sha256":"0"*64,"shader_variants":30000}
        with self.assertRaisesRegex(ValueError,"不匹配"):
            analyze_apk(path,{"build_evidence":evidence})
        evidence.update(apk_sha256=hash_file(path), reference_graph_complete=True,
                        reference_scope_paths=["assets/unused.txt"],referenced_paths=[])
        report=analyze_apk(path,{"build_evidence":evidence})
        self.assertEqual(report["unused_candidates"],["assets/unused.txt"])
        self.assertEqual(report["checks"]["shader_variants"],"build_evidence")

    def test_invalid_rules_and_options(self):
        """作用：拒绝非法红线和非有限指标配置；入参：无；返回：断言结果。"""
        for rules in ({"apk_max_mb":0},{"atlas_min_fill_pct":101},{"unknown":1},{"apk_max_mb":float('nan')}):
            with self.assertRaises(ValueError):
                validate_rules(rules)
        with self.assertRaises(ValueError):
            validate_options({"target_fps":float('nan')},"performance")

    def test_html_escapes_untrusted_content(self):
        """作用：验证离线报告不执行日志或文件名中的脚本；入参：无；返回：断言结果。"""
        report={"analyzer_version":"1","risks":[{"level":"P1","title":"<script>alert(1)</script>","evidence":"<img onerror=x>","suggestion":"x"}],"warnings":[]}
        rendered=html_report({"filename":"<script>bad</script>","created_at":"now"},report)
        self.assertNotIn("<script>",rendered)
        self.assertIn("&lt;script&gt;",rendered)

    def test_comparison_flags_missing_conditions(self):
        """作用：验证异机或未知条件不会宣布优化；入参：无；返回：断言结果。"""
        jobs=[{"id":str(i),"kind":"performance","filename":"capture","created_at":"now","options":{"device":str(i)}} for i in range(2)]
        reports=[{"metrics":{"fps_avg":30}},{"metrics":{"fps_avg":60}}]
        result=comparison(jobs,reports)
        self.assertFalse(result["comparable"])
        self.assertIn("device",result["condition_differences"])
        self.assertEqual(result["rows"][1]["delta_pct"]["fps_avg"],100)

    def test_storage_project_isolation_and_restart(self):
        """作用：验证历史按项目隔离及中断恢复；入参：无；返回：断言结果。"""
        store=Store(self.root/"store")
        store.create("job","project-a","apk","demo.apk",{})
        self.assertIsNone(store.get("project-b","job"))
        self.assertEqual(store.list("project-b","apk"),[])
        restarted=Store(self.root/"store")
        self.assertEqual(restarted.get("project-a","job")["status"],"failed")

    def test_retained_object_stack_from_same_session(self):
        """作用：验证快照增长来源可追溯到分配栈；入参：无；返回：断言结果。"""
        path=self.root/"snapshots.json"
        path.write_text(json.dumps({"samples":[{"time_s":0,"memory_mb":100}],"memory_snapshots":[
            {"objects":[]}, {"objects":[{"id":"stable-1","bytes":1000}]},
            {"objects":[{"id":"stable-1","bytes":2000,"type":"Cache","allocation_stack":["Demo.Load()"]}]}]}))
        report=analyze_performance(path,{})
        self.assertEqual(report["retained_objects"][0]["growth_bytes"],2000)
        self.assertEqual(report["retained_objects"][0]["allocation_stack"],["Demo.Load()"])

    @unittest.skipUnless(__import__('os').environ.get('TRACE_PROCESSOR_PATH'), "需要本地官方 Perfetto 解析器")
    def test_real_perfetto_binary(self):
        """作用：调用官方解析器读取 protobuf 真实字节；入参：无；返回：断言结果。"""
        from scripts.generate_perfetto_sample import generate
        path=generate(self.root/"demo.perfetto-trace")
        report=analyze_performance(path,{"process_name":"com.example.game"})
        self.assertEqual(report["format"],"perfetto_binary")
        self.assertEqual(report["sample_count"],100)
        self.assertAlmostEqual(report["metrics"]["frame_ms"]["mean"],15)


if __name__ == "__main__":
    unittest.main()
