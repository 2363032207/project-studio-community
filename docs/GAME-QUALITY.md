# 游戏性能监控分析与 APK 包体自检

## 目标与落地方式

在 Project Studio 的质量管理导航中增加“性能监控分析”和“APK 包体自检”。适用于个人手游、Unity 游戏及小团队的离线质量检查。

当前版本分析已经采集的文件，不直接连接设备或持续抓取游戏进程。保留项目、设备、场景、构建、图形 API、分辨率、画质和探针模式，支持历史查询、2~6 份数据对比、关键指标趋势和离线报告。

核心使用 Python 3.10+ 标准库：`zipfile`、`hashlib`、`sqlite3`、`csv`、`statistics`、`http.server`。现有 React 工作台和 Fastify 项目权限继续复用。没有引入 pandas、NumPy、Celery、Redis 或新的前端图表运行库。

Perfetto 二进制增加固定版本的官方 `perfetto` Python 包、protobuf 和约 14 MB 的 Trace Processor。默认 Docker 镜像包含它；纯 CSV/JSON/日志/APK 部署可禁用。官方 Python 接口、SQL 查询及自定义二进制路径见 [Perfetto 官方文档](https://perfetto.dev/docs/analysis/trace-processor-python)。

## 组件与数据流

```text
React 工作台
  → Nginx 同源上传（流式转发）
  → Fastify 网关（会话认证、项目成员/只读权限、审计）
  → Python 内部分析服务（内部密钥）
      ├─ SQLite：任务状态、采集条件、规则快照、摘要
      ├─ 任务目录：原始数据、参数、完整 JSON 报告
      └─ 独立子进程：解析 → 归一化 → 指标 → 风险 → 报告
```

任务状态为 `queued → running → completed / failed`。接口收到上传后立即返回任务标识；前端每 4 秒刷新历史。单进程串行分析，最多 8 个排队/执行任务，单任务 180 秒超时；Linux 容器中对工作进程限制 1.5 GiB 地址空间、服务容器限制 2 GiB 内存。超时结束整个分析进程组，重启中断任务记录失败原因并允许重新上传。

任务数据保存在独立 `quality-data` Docker 卷，业务数据仍在 PostgreSQL。每个读写请求携带经网关验证的项目 UUID，原始文件不对公网提供静态目录。

## 目录结构

```text
backend/src/quality.ts                项目鉴权、流式上传与内部代理
backend/test/quality.test.ts          身份与项目只读权限验证
frontend/src/quality.tsx              两个模块的页面、上传、对比和 SVG 图表
frontend/src/quality.css              分析工作台样式
quality-service/
  Dockerfile                         非 root Python 服务与可选 Perfetto 安装
  requirements-perfetto.txt           可选官方解析依赖，固定版本
  quality/
    performance.py                   CSV/JSON/日志/Trace 自动识别与性能分析
    apk.py                           APK 安全解包、资源分类与规则校验
    storage.py                       SQLite 项目隔离历史和配置
    reports.py                       对比结果与转义后的离线 HTML
    server.py                        HTTP 路由、排队和任务子进程
    worker.py                        隔离分析入口
    cli.py                           直接运行的命令行入口
    install_perfetto.py               下载并校验固定版本官方解析器
    unity.py                         可选本地 Unity 原生记录自动转换
    capture.py                       可选 ADB 指定设备/游戏进程日志抓取
  scripts/
    generate_samples.py              生成虚构 CSV/日志/Trace JSON/APK/构建证据
    generate_perfetto_sample.py       生成官方 protobuf 二进制 Trace 验证文件
    smoke_web.py                     Web API 全链路验证
  tests/test_analysis.py              指标、证据与恶意输入测试
integrations/unity/Editor/
  QualityProfilerExporter.cs          Unity 原生 Profiler 导出器
```

新增 Python 函数使用中文 docstring 说明作用、入参和返回值；新增 TypeScript/C# 核心函数使用中文头部说明。

## 性能数据导入

支持以下输入：

- Unity/自定义采样 CSV：自动识别逗号、分号或制表符，支持 UTF-8 BOM、UTF-16 和常见中文编码。
- 结构化 JSON：`{"samples":[...]}` 或采样对象数组；可附带对象快照。
- Perfetto/Chrome Trace JSON：识别 `traceEvents`，处理完整事件和开始/结束事件、计数器、GC 与包含耗时热点。
- Perfetto 二进制：`.pftrace`、`.perfetto-trace`、`.pb`；调用本地官方 Trace Processor。优先使用单一 PlayerLoop/Frame 轨道，缺少时读取 Android FrameTimeline 单一进程图层。
- 游戏日志：`.log`、`.txt` 以及非采样 JSON 日志，提取 Error/Fatal/Warning、Android E/F/W 级别和异常堆栈，按错误签名与场景聚合。
- Unity 原生 `.raw/.data`：自动识别原生格式；配置本地 Unity 适配器后可自动转换。默认 Linux 镜像未携带 Unity Editor，需要先从编辑器导出 JSON。

Unity 官方支持在编辑器中加载原生记录，而不是把 `.raw` 作为文本 CSV 读取，参见 [Profiler 文件说明](https://docs.unity.com/en-us/engine/6000.7/manual/analysis/profiler/window) 和 [RawFrameDataView 接口](https://docs.unity.com/en-us/engine/7000.0/script-reference/unityeditor/profiling/rawframedataview)。

### 标准采样格式

```csv
time_s,frame_ms,cpu_ms,gpu_ms,gpu_load_pct,memory_mb,gc_count,gc_ms,cpu_freq_mhz,temperature_c,scene
0,16.2,8.1,10.4,65,256,0,0,2200,36,DemoArena
1,80,50,19,90,258,1,24,2200,36,DemoArena
```

- `time_s`：采样秒数；缺失时按导入指定的采样间隔推算，并在报告中标注。
- `frame_ms`：帧耗时；只有 `fps` 时以 `1000/fps` 估算，不能把平均 FPS 采样视为真实逐帧分布。
- `cpu_ms/gpu_ms`：采集到的主线程/GPU 耗时，单位毫秒。GPU 耗时和 GPU 负载不是同一指标。
- `gpu_load_pct`：设备提供的 GPU 利用率百分比；没有相应计数器时显示未采集。
- `memory_mb`：单位按 MiB（1024² 字节）约定；请统一使用同一种内存口径，勿混合 reserved、allocated 和 RSS。
- `gc_count`：该采样间隔新增回收次数，不是累计计数。`gc_ms` 为该间隔回收耗时；`GC.Alloc` 不是 GC 回收。
- `cpu_freq_mhz`：同一 CPU 核/集群的时钟频率；导入前统一采样来源，不能混合大小核频率。
- `gpu_supported=false`、负数、空值、NaN 等视为未采集，不当作零。
- `scene`：场景或关卡；未填写时可使用上传窗口的场景字段。

内置常见别名，例如 `cpu_main_ms`、`frame_time_ms`、`unity_allocated_mb`。字段扩展在 `performance.py` 的 `ALIASES` 中集中维护。超出通用字段的厂商 CSV 需要适配器，无法识别时明确失败，不生成伪造报告。

### 指标与风险口径

- 平均 FPS 为 `1000 / mean(frame_ms)`；1% Low 为最慢 1% 样本平均耗时的倒数。
- P50/P95/P99 使用线性插值分位。报告展示均值/P50/P95/P99/最大值。
- 卡顿阈值为目标帧预算的 1.5 倍：目标 60 FPS 时约 25 ms。展示最慢 100 个超预算样本和对应时间/场景。
- GC 有同一 Trace 时钟时计算与卡顿窗口的重叠耗时；CSV 中展示同一采样行的 GC 数值。不同文件不会擅自对齐时钟。
- 内存增长候选需至少 60 个有效样本、持续 60 秒、净增长至少 10 MiB、线性回归斜率至少 0.5 MiB/min。
- 低频候选为低于起始样本频率基线 70%，至少连续 3 个样本且持续 2 秒。DVFS 节能也会降频，需温度与持续负载确认热降频。
- 内存趋势不能证明泄漏；需要同一循环 GC 后基线、对象快照、分配栈和持有引用链。没有这些数据时显示“候选/待确认”。
- 帧标记和 FrameTimeline 的工作耗时不等于屏幕呈现间隔，其倒数标为吞吐估算。参见 [FrameTimeline 官方口径](https://perfetto.dev/docs/data-sources/frametimeline)。
- 热点是包含子调用的时间，不能相加当 CPU 总时间；GPU 不支持时不通过 CPU 等待时间猜测 GPU 耗时。

P0 表示阻断性超限（例如 500 ms 以上卡顿样本）；P1 表示明显卡顿、持续增长/大量 GC、错误日志；P2 表示低频候选或低频卡顿。建议与证据同时输出，不自动修改游戏源码。

趋势最多 600 桶；每桶显示耗时峰值、内存末值。报告保留完整关键样本摘要，缺失指标断线而不补零。

### 内存对象快照

在 JSON 的 `samples` 旁加入 `memory_snapshots`，最多 20 次，每次最多 100000 项：

```json
{
  "samples": [{"time_s":0,"memory_mb":200},{"time_s":60,"memory_mb":240}],
  "memory_snapshots": [
    {"objects": [{"id":"stable-object-1","bytes":100,"type":"TextureCache"}]},
    {"objects": [{"id":"stable-object-1","bytes":1000,"type":"TextureCache"}]},
    {"objects": [{"id":"stable-object-1","bytes":2000,"type":"TextureCache",
      "allocation_stack":["Demo.Cache.Load()","Demo.Scene.Enter()"]}]}
  ]
}
```

对象 ID 必须在同次运行中稳定，快照按时间顺序传入。报告展示连续保留且相对首次快照新增/增长的候选及调用位置；仍需检查业务缓存寿命。它不是 Unity Memory Profiler 二进制快照解析器，需要先转换成该证据格式。

### Unity 原生 Profiler 转换

把 `integrations/unity/Editor/QualityProfilerExporter.cs` 复制到个人游戏工程的 `Assets/Editor/`。在 Unity 中选择 `Tools → Quality → Export Profiler Record to JSON`，选择 `.raw/.data` 再导出 JSON。建议使用产生记录的相同版本编辑器（Unity 2022.3 LTS/Unity 6）。

也可以在运行 Python 服务的 Windows 主机设置 `QUALITY_UNITY_EDITOR` 为编辑器可执行文件绝对路径、`QUALITY_UNITY_PROJECT` 为装有导出器且未被另一编辑器占用的可信工程。上传 `.raw` 后工作进程会调用 `-batchmode -executeMethod QualityProfilerExporter.BatchExport`；转换超时 120 秒。

导出器提取主线程帧时间、PlayerLoop、完整 GC 标记和有效的 GPU 帧时间；Unity 6 中可读取有效的 Total Used Memory 计数器。GPU、内存计数器缺失时输出 -1。它未在当前环境的真实 Unity 编辑器中编译验证；不同 Unity 版本需要实际工程复核。建议后续按游戏的 Recorder/FrameTimingManager 增加 GPU 负载和构建元数据采集。

## APK 包体自检

逐个读取 ZIP 条目并流式解压，校验 CRC、统计目录、压缩前后字节与 SHA-256；不执行 dex/so，不把包内路径直接解压到文件系统。

分类互斥：dex、so、资源、音频、图集、视频、图片、其他。扩展名和路径提供第一层分类；Unity 的 `.assets/AssetBundle` 内部文件不能通过 ZIP 名称直接拆成纹理与音频，后续需构建报告/序列化解析适配器。Android 官方 APK Analyzer 同样区分 ZIP 包体大小与组成，可参考 [Android APK Analyzer](https://developer.android.com/studio/debug/apk-analyzer)。

目前可以直接从 APK 可靠获得：

- 原始 APK 大小、解压大小、目录递归大小、文件明细及前后对比。
- 完全重复的文件内容（SHA-256 + 大小）；展示潜在解压字节节省，多 ABI 必要副本需要人工判断。
- 超大单文件、图片文件大小、PNG/JPEG/WebP/ASTC/KTX/KTX2 的可识别尺寸。
- 大型 Stored 文本候选；不将 `so/resources.arsc` 一概判为压缩违规，避免破坏 mmap/安装条件。
- 自定义 APK 大小、图片大小/最长边、单文件大小和 SO 文件数量红线。

默认红线：APK ≤ 500 MiB、图片 ≤ 2 MiB、单文件 ≤ 50 MiB、图片最长边 ≤ 4096 px、SO 文件数 ≤ 40、Shader 变体 ≤ 20000、图集占用率 ≥ 65%。规则为每项目保存，随任务写入快照，对历史报告不追溯改写。

### 构建证据检查

仅凭 APK 不能确认动态资源引用关系，也不能稳定枚举 Unity 已编译 Shader 变体或判断打包图集空闲区域。上传窗口允许补充与本次 APK SHA-256 匹配的 JSON，缺失时明确显示“未提供构建证据”。

```json
{
  "apk_sha256": "此 APK 的 64 位 SHA-256",
  "reference_graph_complete": true,
  "reference_scope_paths": ["assets/config/tutorial.json", "assets/config/debug.json"],
  "referenced_paths": ["assets/config/tutorial.json"],
  "dynamic_paths": [],
  "shader_variants": 12000,
  "atlases": [
    {"path":"assets/ui/main_atlas.png","width":2048,"height":2048,"used_area":2400000}
  ]
}
```

引用候选只在 `reference_scope_paths` 指定的完整性检查范围内产生，并排除静态和动态路径；路径必须是 APK ZIP 内路径。完整性声明须由项目构建流水线提供，工具无法凭空验证动态加载是否全部记录。

图集占用率为 `used_area / (width × height)`，是空闲比例代理指标，不代表纹理连通区域的几何碎片分析。Shader 数量需要来自本次构建已剔除后的计数。Unity 支持导出 Shader 变体信息，参考 [Unity 官方 Shader 变体说明](https://unity.com/blog/engine-platform/shader-variants-optimization-troubleshooting-tips)。

## 部署与使用

### 推荐：已有项目 Docker Compose

```powershell
docker compose up --build -d
```

登录后进入：

- 性能分析：`http://127.0.0.1:8088/#performance`
- APK 自检：`http://127.0.0.1:8088/#apk`

首次构建会下载固定版本官方解析器并校验 SHA-256；运行时不自动从第三方下载可执行程序，也不会上传采集文件到 Perfetto 云端。

只使用标准库能力时：

```powershell
docker compose build --build-arg WITH_PERFETTO=false quality
docker compose up -d quality
```

性能页面选择 1~6 个文件、填写采集条件后上传；任务完成后查看报告。勾选 2~6 个已完成历史，按选择顺序比较，第一份为基线。条件不一致或缺失时提示仅供参考；单轮变化不直接宣布优化成功。

APK 页面先设置“质量红线”，上传 APK，可选粘贴构建证据 JSON，再看资源分类、目录、重复文件和违规项。

两模块支持下载 JSON 与离线 HTML；打开 HTML 后可用浏览器打印为 PDF。历史中的删除操作同时移除原始文件与报告，页面会二次确认。

### 本地 Python 服务

默认基础功能不需要 pip 安装。先切换到 `quality-service`，设置 `QUALITY_SERVICE_KEY` 与现有后端 `APP_SECRET` 一致（不要把真实密钥写入代码）：

```powershell
python -m quality.server
```

默认监听 `127.0.0.1:8090`。后端设置 `QUALITY_SERVICE_URL=http://127.0.0.1:8090`，前端仍使用现有 Vite `/api` 代理。可用 `QUALITY_DATA_DIR` 指定任务数据目录，`QUALITY_PORT` 指定端口。不要直接公开内部分析服务端口。

启用二进制 Perfetto：

```powershell
python -m pip install -r requirements-perfetto.txt
python -m quality.install_perfetto data/tools/trace_processor_shell.exe
$env:TRACE_PROCESSOR_PATH = (Resolve-Path data/tools/trace_processor_shell.exe).Path
python -m quality.server
```

Linux 使用无 `.exe` 的目标名。官方二进制按运行系统下载，不能把 Windows exe 放入 Linux 容器。

### 独立命令行分析

```powershell
cd quality-service
python scripts/generate_samples.py data/samples
python -m quality.cli data/samples/performance-baseline.csv --kind performance --output data/reports/performance
python -m quality.cli data/samples/demo-game.apk --kind apk --options data/samples/apk-options.json --output data/reports/apk
```

样例 APK 为只含虚构占位文件的 ZIP，不可安装；用于检查结构与规则。生成的游戏数据、任务、HTML、APK 均位于被 Git 忽略的 `data/` 目录。真实 APK、日志与 Trace 也应放在该目录或仓库外，避免发布业务内容。

### 可选：抓取 Android 游戏日志

电脑安装 Android Platform Tools，设备完成 USB 调试授权并运行游戏后：

```powershell
adb devices -l
python -m quality.capture --serial YOUR_DEVICE_SERIAL --package com.example.game --duration 60 --output data/device-session-01.log
```

工具只抓取指定设备、指定包的当前第一个进程，不清空原日志。多进程游戏可后续扩展 PID 选择。抓取完成后把日志导入“性能监控分析”；若游戏未打印场景标识，只能显示未标记或上传时指定的场景。当前环境未连接 Android 设备，采集入口尚未完成真机验证。

### 验证

```powershell
cd quality-service
python -m unittest discover -s tests -v
python scripts/generate_perfetto_sample.py data/samples/demo.perfetto-trace
python -m quality.cli data/samples/demo.perfetto-trace --kind performance --output data/reports/perfetto
```

最后两条需要可选 Perfetto 依赖和 `TRACE_PROCESSOR_PATH`。Web 全链路脚本使用环境变量 `QUALITY_TEST_EMAIL` / `QUALITY_TEST_PASSWORD` 登录本地系统，执行 `python scripts/smoke_web.py`，不会回显凭据。

### API 约定

所有外部接口基于 `/api/projects/{projectId}/quality`，使用现有会话 Bearer Token：

- `POST /configs`：JSON 提交 `kind`、采集条件、规则快照、构建证据，返回一小时有效的配置 ID。
- `POST /jobs?kind=performance|apk`：二进制正文，`Content-Type: application/octet-stream`；文件名经 URI 编码放入 `X-Filename`，配置 ID 放入 `X-Analysis-Config`，必须有 Content-Length，返回 202。
- `GET /jobs?kind=...`：最近 100 次历史；`GET /jobs/{id}`：状态。
- `GET /jobs/{id}/report`：完整 JSON；`GET /jobs/{id}/report.html`：离线 HTML 附件。
- `GET /compare?ids=id1,id2`：同类型已完成任务对比。
- `GET /rules` / `PUT /rules`：读取/保存项目红线。
- `DELETE /jobs/{id}`：删除已结束历史和原始附件，执行中任务不允许删除。

网关拦截未登录和跨项目请求，viewer 不能上传/改规则/删除。内部服务要求独立 HTTP 头密钥，业务会话 Token 不转发给 Python。

## 输入限制与维护

单文件 ≤ 1 GiB，文本 ≤ 128 MiB，采样 ≤ 500000，Trace JSON ≤ 100 万事件；APK ≤ 60000 条目、总解压 ≤ 4 GiB、单条目 ≤ 1 GiB、解压比例 ≤ 1000。拒绝路径穿越、加密和符号链接条目。超限返回明确失败，不将部分报告当全量成功。

同一项目最新 100 条可在 UI 看到，旧数据不会自动删除。可逐条删除已结束任务；定期备份质量数据卷（包含 SQLite、原始附件与报告），或停服务后完整复制卷。项目业务删除不会自动删除质量卷历史，维护时应一并清理对应项目历史。

HTML 中所有日志、文件名、路径经过转义，报告不加载外部脚本。服务为轻量内网/个人用途，没有在当前版本宣称大文件吞吐、多租户公网隔离或恶意输入的完整沙箱保证。

## 后续扩展

1. 采集端：ADB/Perfetto 录制、Unity Recorder/FrameTimingManager、统一场景时间轴和构建签名；默认只保存用户选择的采集数据。
2. 真正的呈现 FPS：增加 FrameTimeline 呈现间隔、掉帧类型和 GPU vendor 计数器适配，不把 PlayerLoop 耗时替代显示时序。
3. 内存：适配 Unity Memory Profiler 快照，展示保留引用链、场景进出后的 GC 基线与对象组差异。
4. APK：接入 Android `apkanalyzer/aapt2` 的编译资源引用、Unity BuildReport、AssetBundle/Addressables 清单、Shader 和图集构建导出器。
5. 质量闭环：失败执行或性能 P0 一键关联工作项、CI 上传、基线门禁、多轮显著性对比；修改前保留原始证据。
6. 数据规模：分页历史、保留策略、任务取消与重试、多 worker、队列、对象存储与更严格的执行沙箱。达到规模再引入重型基础设施。
