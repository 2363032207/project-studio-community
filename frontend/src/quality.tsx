import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, tokenStore } from "./api";
import { Empty, Modal, PageHeader } from "./ui";
import "./quality.css";

type Kind = "performance" | "apk";
type Risk = {
  level: string;
  title: string;
  evidence: string;
  suggestion: string;
  path?: string;
};
type Stats = {
  count: number;
  mean: number;
  p50?: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
};
type Metrics = Record<string, number | Stats | null>;
type Point = {
  time_s: number;
  scene?: string;
  [key: string]: number | string | null | undefined;
};
type Job = {
  id: string;
  filename: string;
  status: string;
  error?: string;
  created_at: string;
  options: Record<string, unknown>;
  summary?: {
    format: string;
    metrics?: Metrics;
    apk_bytes?: number;
    sample_count?: number;
    risk_counts: Record<string, number>;
  };
};
type Report = {
  kind: Kind;
  format: string;
  analyzer_version: string;
  risks: Risk[];
  warnings: string[];
  notes?: string[];
  metrics?: Metrics;
  trend?: Point[];
  sample_count?: number;
  duration_s?: number;
  missing_metrics?: string[];
  logs?: {
    type: string;
    severity: string;
    scene: string;
    message: string;
    count: number;
    stack: string[];
    line: number;
    first_time?: string | null;
    last_time?: string | null;
  }[];
  hotspots?: {
    name: string;
    total_ms: number;
    count: number;
    max_ms: number;
  }[];
  jank_frames?: Point[];
  retained_objects?: {
    id: string;
    type: string;
    growth_bytes: number;
    allocation_stack: string[];
    evidence: string;
  }[];
  gc_events?: { time_s: number; duration_ms: number; name: string }[];
  low_frequency_intervals?: {
    start_s: number;
    end_s: number;
    baseline_mhz: number;
  }[];
  apk_bytes?: number;
  uncompressed_bytes?: number;
  file_count?: number;
  apk_sha256?: string;
  categories?: Record<
    string,
    {
      bytes: number;
      compressed_bytes: number;
      count: number;
      percentage: number;
    }
  >;
  directory_tree?: { path: string; bytes: number; count: number }[];
  files?: {
    path: string;
    category: string;
    bytes: number;
    compressed_bytes: number;
    dimensions: number[] | null;
    compression: string;
  }[];
  duplicates?: {
    paths: string[];
    bytes_each: number;
    potential_saving_bytes: number;
  }[];
  checks?: Record<string, string>;
  shader_variants?: number | null;
  atlases?: { path: string; fill_pct: number; width: number; height: number }[];
};
type Compare = {
  rows: {
    id: string;
    filename: string;
    created_at: string;
    values: Record<string, number | null>;
    delta_pct: Record<string, number | null>;
  }[];
  comparable: boolean;
  condition_differences: string[];
  unknown_conditions: string[];
  warnings: string[];
};
const RULE_LABELS: Record<string, string> = {
  apk_max_mb: "APK 总大小上限（MiB）",
  image_max_mb: "单张图片上限（MiB）",
  single_file_max_mb: "单文件上限（MiB）",
  image_max_dimension: "图片最长边（px）",
  so_max_count: "so 文件数量上限",
  shader_variants_max: "Shader 变体上限",
  atlas_min_fill_pct: "图集最低占用率（%）",
};
const METRIC_LABELS: Record<string, string> = {
  fps_avg: "平均 FPS",
  fps_1pct_low: "1% Low FPS",
  jank_pct: "卡顿样本 %",
  memory_growth_mb: "内存净增长 MiB",
  memory_slope_mb_min: "内存斜率 MiB/min",
  gc_total_ms: "GC 总耗时 ms",
  gc_count: "GC 次数 / 间隔",
  temperature_c: "温度 °C",
  frame_ms: "帧耗时 ms",
  cpu_ms: "CPU 耗时 ms",
  gpu_ms: "GPU 耗时 ms",
  gpu_load_pct: "GPU 负载 %",
  memory_mb: "内存 MiB",
  gc_ms: "GC 耗时 ms",
  cpu_freq_mhz: "CPU 频率 MHz",
  apk_bytes: "APK 大小 bytes",
  uncompressed_bytes: "解压大小 bytes",
  file_count: "文件数",
  shader_variants: "Shader 变体数",
};
const CATEGORY_LABELS: Record<string, string> = {
  dex: "DEX",
  so: "原生库 SO",
  resources: "其他资源",
  images: "图片",
  atlas: "图集",
  audio: "音频",
  video: "视频",
  other: "其他文件",
};
const STATUS: Record<string, string> = {
  queued: "排队中",
  running: "分析中",
  completed: "已完成",
  failed: "失败",
};

/** 作用：格式化可选数值；入参：数值、精度；返回：可读字符串，缺失显示未采集。 */
function numeric(value: unknown, digits = 2): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: digits })
    : "未采集";
}

/** 作用：格式化文件大小；入参：字节数；返回：自适应 B/KiB/MiB 字符串。 */
function size(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1024) return `${numeric(value, 0)} B`;
  if (value < 1024 ** 2) return `${numeric(value / 1024)} KiB`;
  return `${numeric(value / 1024 ** 2)} MiB`;
}

/** 作用：下载带项目鉴权的分析报告；入参：地址、下载名；返回：下载结束的 Promise。 */
async function download(path: string, filename: string): Promise<void> {
  const response = await fetch(path, {
    headers: { Authorization: `Bearer ${tokenStore.get()}` },
  });
  if (!response.ok) throw new Error("报告下载失败");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 作用：绘制有单位的趋势折线；入参：标题、点列、字段、说明；返回：无重型依赖的 SVG 图表。 */
function Trend({
  title,
  points,
  metric,
  caption = "采样时间（s）",
}: {
  title: string;
  points: Point[];
  metric: string;
  caption?: string;
}) {
  const valid = points.filter((point) => typeof point[metric] === "number");
  if (!valid.length)
    return (
      <section className="panel q-chart">
        <h3>{title}</h3>
        <Empty
          title="未采集此指标"
          description="请补充对应采集计数器，缺失值不会作为零绘制。"
        />
      </section>
    );
  const minimum = Math.min(0, ...valid.map((point) => Number(point[metric])));
  const maximum = Math.max(
    minimum + 1,
    ...valid.map((point) => Number(point[metric])),
  );
  const start = points[0]?.time_s ?? 0,
    end = Math.max(start + 1, points[points.length - 1]?.time_s ?? 1);
  let drawing = "",
    previous = false;
  for (const point of points) {
    if (typeof point[metric] !== "number") {
      previous = false;
      continue;
    }
    const x = 50 + ((point.time_s - start) / (end - start)) * 630;
    const y =
      175 - ((Number(point[metric]) - minimum) / (maximum - minimum)) * 140;
    drawing += `${previous ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)} `;
    previous = true;
  }
  return (
    <section className="panel q-chart">
      <h3>{title}</h3>
      <svg
        role="img"
        aria-label={`${title}，${valid.length} 个有效采样点`}
        viewBox="0 0 720 220"
      >
        <line x1="50" y1="175" x2="680" y2="175" stroke="#dfe6f2" />
        <line x1="50" y1="35" x2="680" y2="35" stroke="#edf1f7" />
        <text x="4" y="40">
          {numeric(maximum, 1)}
        </text>
        <text x="4" y="178">
          {numeric(minimum, 1)}
        </text>
        <path d={drawing} fill="none" stroke="#4263eb" strokeWidth="2.5" />
        {valid.length === 1 && (
          <circle
            cx="50"
            cy={
              175 -
              ((Number(valid[0]?.[metric]) - minimum) / (maximum - minimum)) *
                140
            }
            r="4"
            fill="#4263eb"
          />
        )}
        <text x="50" y="200">
          {numeric(start, 1)}
        </text>
        <text x="625" y="200">
          {numeric(end, 1)}
        </text>
      </svg>
      <small>
        {caption} · {valid.length} 点 · 缺失处断线
      </small>
    </section>
  );
}

/** 作用：展示 P0/P1/P2 风险与建议；入参：风险列表；返回：可按等级筛选的风险区域。 */
function Risks({ risks }: { risks: Risk[] }) {
  const [level, setLevel] = useState("all");
  const filtered = risks.filter(
    (risk) => level === "all" || risk.level === level,
  );
  return (
    <section className="panel">
      <header className="panel-title">
        <div>
          <h3>风险与优化建议</h3>
          <p>P0 阻断红线 · P1 重点处理 · P2 持续优化</p>
        </div>
        <select
          aria-label="风险等级"
          value={level}
          onChange={(event) => setLevel(event.target.value)}
        >
          <option value="all">全部等级</option>
          {["P0", "P1", "P2"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </header>
      <div className="q-risk-list">
        {filtered.slice(0, 200).map((risk, index) => (
          <article key={index} className={`q-risk ${risk.level}`}>
            <span className={`q-level ${risk.level}`}>{risk.level}</span>
            <div>
              <strong>{risk.title}</strong>
              {risk.path && <code>{risk.path}</code>}
              <p>{risk.evidence}</p>
              <p className="q-advice">{risk.suggestion}</p>
            </div>
          </article>
        ))}
        {!filtered.length && (
          <Empty
            title="当前筛选没有风险项"
            description="结论仅覆盖已采集数据，未采集项不代表通过。"
          />
        )}
        {filtered.length > 200 && (
          <p>页面展示前 200 项，下载 JSON 查看全部 {filtered.length} 项。</p>
        )}
      </div>
    </section>
  );
}

/** 作用：展示性能报告；入参：分析报告；返回：指标、趋势、卡顿、日志与热点视图。 */
function PerformanceReport({ report }: { report: Report }) {
  const [detail, setDetail] = useState("frames"),
    [scene, setScene] = useState("all");
  const metrics = report.metrics ?? {};
  const keys = [
    "fps_avg",
    "fps_1pct_low",
    "jank_pct",
    "memory_growth_mb",
    "gc_total_ms",
  ];
  const logs = report.logs ?? [];
  return (
    <>
      <div className="metric-grid metric-grid-five">
        {keys.map((key) => (
          <article className="metric accent-blue" key={key}>
            <span>{METRIC_LABELS[key]}</span>
            <strong>{numeric(metrics[key])}</strong>
            <small>
              {report.sample_count} 个采样 · {numeric(report.duration_s)}s
            </small>
          </article>
        ))}
      </div>
      <div className="q-chart-grid">
        {[
          "frame_ms",
          "cpu_ms",
          "gpu_ms",
          "memory_mb",
          "gpu_load_pct",
          "cpu_freq_mhz",
        ].map((key) => (
          <Trend
            key={key}
            title={METRIC_LABELS[key] ?? key}
            points={report.trend ?? []}
            metric={key}
          />
        ))}
      </div>
      <section className="panel">
        <header className="panel-title">
          <h3>性能采样统计</h3>
          <span>耗时分位基于有效样本</span>
        </header>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>指标</th>
                <th>有效样本</th>
                <th>均值</th>
                <th>P50</th>
                <th>P95</th>
                <th>P99</th>
                <th>最大值</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(metrics)
                .filter(([, value]) => value && typeof value === "object")
                .map(([key, value]) => {
                  const stat = value as Stats;
                  return (
                    <tr key={key}>
                      <td>{METRIC_LABELS[key] ?? key}</td>
                      <td>{stat.count}</td>
                      <td>{numeric(stat.mean)}</td>
                      <td>{numeric(stat.p50)}</td>
                      <td>{numeric(stat.p95)}</td>
                      <td>{numeric(stat.p99)}</td>
                      <td>{numeric(stat.max)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>
      <Risks risks={report.risks} />
      <section className="panel q-section">
        <h3>内存保留对象与 GC 证据</h3>
        <p className="q-help">
          对象位置来自同次运行快照的稳定 ID
          和分配栈。只有采样曲线时仅报告增长区间。
        </p>
        {!report.retained_objects?.length && (
          <p className="q-help">尚无可定位的对象快照，不能确认具体泄漏对象。</p>
        )}
        {report.retained_objects?.map((object) => (
          <details className="q-log" key={object.id}>
            <summary>
              <b>{object.type}</b>
              <span>
                {object.id} · 保留增长 {size(object.growth_bytes)}
              </span>
            </summary>
            <pre>
              {object.allocation_stack.join("\n") || "无分配调用栈"}
              {"\n"}
              {object.evidence}
            </pre>
          </details>
        ))}
        {!!report.gc_events?.length && (
          <details className="q-log">
            <summary>GC 事件时间线（{report.gc_events.length} 项）</summary>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>时间 s</th>
                    <th>标记</th>
                    <th>耗时 ms</th>
                  </tr>
                </thead>
                <tbody>
                  {report.gc_events.slice(0, 200).map((event, index) => (
                    <tr key={index}>
                      <td>{numeric(event.time_s)}</td>
                      <td>{event.name}</td>
                      <td>{numeric(event.duration_ms)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
      <div className="view-tabs">
        {[
          ["frames", "卡顿帧"],
          ["logs", `日志分类 ${logs.length}`],
          ["hotspots", "调用热点"],
          ["frequency", "低频区间"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={detail === key ? "active" : ""}
            onClick={() => setDetail(key!)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="panel">
        <div className="table-wrap">
          {detail === "frames" ? (
            <table>
              <thead>
                <tr>
                  <th>时间 s</th>
                  <th>场景</th>
                  <th>帧耗时 ms</th>
                  <th>GC ms</th>
                  <th>内存 MiB</th>
                </tr>
              </thead>
              <tbody>
                {report.jank_frames?.map((point, index) => (
                  <tr key={index}>
                    <td>{numeric(point.time_s)}</td>
                    <td>{String(point.scene)}</td>
                    <td className="q-bad">{numeric(point.frame_ms)}</td>
                    <td>{numeric(point.gc_overlap_ms ?? point.gc_ms)}</td>
                    <td>{numeric(point.memory_mb)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : detail === "logs" ? (
            <>
              <div className="q-section-tools">
                <label>
                  场景筛选
                  <select
                    value={scene}
                    onChange={(event) => setScene(event.target.value)}
                  >
                    <option value="all">全部场景</option>
                    {Array.from(new Set(logs.map((log) => log.scene))).map(
                      (value) => (
                        <option key={value}>{value}</option>
                      ),
                    )}
                  </select>
                </label>
              </div>
              {logs
                .filter((log) => scene === "all" || scene === log.scene)
                .map((log, index) => (
                  <details className="q-log" key={index}>
                    <summary>
                      <b>{log.type}</b>
                      <span>{log.scene}</span>
                      <span>
                        {log.count} 次 · 首次行 {log.line}
                        {log.first_time &&
                          ` · ${log.first_time} → ${log.last_time}`}
                      </span>
                    </summary>
                    <pre>
                      {log.message}
                      {"\n"}
                      {log.stack.join("\n")}
                    </pre>
                  </details>
                ))}
              {!logs.length && <Empty title="未提取到错误或警告" />}
            </>
          ) : detail === "hotspots" ? (
            <table>
              <thead>
                <tr>
                  <th>标记</th>
                  <th>次数</th>
                  <th>累计包含耗时 ms</th>
                  <th>最大 ms</th>
                </tr>
              </thead>
              <tbody>
                {report.hotspots?.map((hotspot, index) => (
                  <tr key={index}>
                    <td>{hotspot.name}</td>
                    <td>{hotspot.count}</td>
                    <td>{numeric(hotspot.total_ms)}</td>
                    <td>{numeric(hotspot.max_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>开始 s</th>
                  <th>结束 s</th>
                  <th>起始基线 MHz</th>
                  <th>判定</th>
                </tr>
              </thead>
              <tbody>
                {report.low_frequency_intervals?.map((interval, index) => (
                  <tr key={index}>
                    <td>{numeric(interval.start_s)}</td>
                    <td>{numeric(interval.end_s)}</td>
                    <td>{numeric(interval.baseline_mhz)}</td>
                    <td>低频候选，需温度与负载证据</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

/** 作用：展示 APK 结构报告；入参：分析报告；返回：分类、资源明细、证据与违规视图。 */
function ApkReport({ report }: { report: Report }) {
  const [detail, setDetail] = useState("files"),
    [search, setSearch] = useState(""),
    [filePage, setFilePage] = useState(0);
  const files = (report.files ?? []).filter((file) =>
    file.path.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <div className="metric-grid">
        {[
          ["APK 大小", size(report.apk_bytes)],
          ["解压后大小", size(report.uncompressed_bytes)],
          ["文件总数", numeric(report.file_count, 0)],
          ["违规项", String(report.risks.length)],
        ].map(([label, value]) => (
          <article className="metric accent-violet" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </article>
        ))}
      </div>
      <section className="panel q-section">
        <h3>包体分类占比</h3>
        <p className="q-help">
          占比按解压字节统计；同时列出 ZIP 压缩字节，不包含 ZIP 目录与签名开销。
        </p>
        <div className="q-categories">
          {Object.entries(report.categories ?? {}).map(([key, value]) => (
            <article key={key}>
              <div>
                <strong>{CATEGORY_LABELS[key] ?? key}</strong>
                <span>{numeric(value.percentage, 1)}%</span>
              </div>
              <div className={`q-category-bar q-cat-${key}`}>
                <i style={{ width: `${value.percentage}%` }} />
              </div>
              <small>
                {value.count} 文件 · 解压 {size(value.bytes)} · ZIP{" "}
                {size(value.compressed_bytes)}
              </small>
            </article>
          ))}
        </div>
      </section>
      <section className="panel q-section">
        <h3>构建证据检查</h3>
        <div className="q-checks">
          {Object.entries(report.checks ?? {}).map(([key, value]) => (
            <article key={key}>
              <span>
                {
                  (
                    {
                      references: "未引用资源",
                      shader_variants: "Shader 变体",
                      atlas_fill: "图集占用率",
                    } as Record<string, string>
                  )[key]
                }
              </span>
              <b className={value === "not_available" ? "q-unknown" : ""}>
                {value === "not_available"
                  ? "未提供构建证据"
                  : "已校验匹配的构建证据"}
              </b>
            </article>
          ))}
        </div>
        <p className="q-hash">APK SHA-256：{report.apk_sha256}</p>
      </section>
      <Risks risks={report.risks} />
      <div className="view-tabs">
        {[
          ["files", "资源清单"],
          ["tree", "目录结构"],
          ["duplicates", "重复内容"],
          ["atlases", "图集与 Shader"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={detail === key ? "active" : ""}
            onClick={() => setDetail(key!)}
          >
            {label}
          </button>
        ))}
      </div>
      <section className="panel">
        {detail === "files" && (
          <div className="q-section-tools">
            <input
              aria-label="搜索资源路径"
              placeholder="搜索资源路径"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setFilePage(0);
              }}
            />
            <span>共 {files.length} 项</span>
            <button
              disabled={!filePage}
              onClick={() => setFilePage(filePage - 1)}
            >
              上一页
            </button>
            <button
              disabled={(filePage + 1) * 100 >= files.length}
              onClick={() => setFilePage(filePage + 1)}
            >
              下一页
            </button>
          </div>
        )}
        <div className="table-wrap">
          {detail === "files" ? (
            <table>
              <thead>
                <tr>
                  <th>资源路径</th>
                  <th>分类</th>
                  <th>解压大小</th>
                  <th>ZIP 大小</th>
                  <th>尺寸</th>
                  <th>存储方式</th>
                </tr>
              </thead>
              <tbody>
                {files
                  .slice(filePage * 100, (filePage + 1) * 100)
                  .map((file) => (
                    <tr key={file.path}>
                      <td className="q-path">{file.path}</td>
                      <td>{CATEGORY_LABELS[file.category]}</td>
                      <td>{size(file.bytes)}</td>
                      <td>{size(file.compressed_bytes)}</td>
                      <td>{file.dimensions?.join(" × ") ?? "—"}</td>
                      <td>{file.compression}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          ) : detail === "tree" ? (
            <table>
              <thead>
                <tr>
                  <th>目录</th>
                  <th>递归文件数</th>
                  <th>解压大小</th>
                </tr>
              </thead>
              <tbody>
                {report.directory_tree?.slice(0, 1000).map((directory) => (
                  <tr key={directory.path}>
                    <td className="q-path">
                      {"　".repeat(
                        Math.min(8, directory.path.split("/").length - 2),
                      )}
                      {directory.path}
                    </td>
                    <td>{directory.count}</td>
                    <td>{size(directory.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : detail === "duplicates" ? (
            <table>
              <thead>
                <tr>
                  <th>完全重复的路径</th>
                  <th>每份大小</th>
                  <th>潜在解压节省</th>
                </tr>
              </thead>
              <tbody>
                {report.duplicates?.map((duplicate, index) => (
                  <tr key={index}>
                    <td className="q-path">
                      {duplicate.paths.map((path) => (
                        <div key={path}>{path}</div>
                      ))}
                    </td>
                    <td>{size(duplicate.bytes_each)}</td>
                    <td>{size(duplicate.potential_saving_bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="q-section">
              <p>Shader 变体数量：{numeric(report.shader_variants, 0)}</p>
              {report.atlases?.map((atlas) => (
                <p key={atlas.path}>
                  {atlas.path} · {atlas.width} × {atlas.height} · 占用率{" "}
                  {numeric(atlas.fill_pct)}%
                </p>
              ))}
              {!report.atlases?.length && (
                <p className="q-help">
                  导入同一 APK 的构建证据后展示图集占用率。
                </p>
              )}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

/** 作用：多文件指标对比；入参：服务端比较结果；返回：相对变化表与运行顺序趋势。 */
function Comparison({ result }: { result: Compare }) {
  const keys = Object.keys(result.rows[0]?.values ?? {});
  const [metric, setMetric] = useState(keys[0] ?? "fps_avg");
  const points: Point[] = result.rows.map((row, index) => ({
    time_s: index,
    ...row.values,
  }));
  return (
    <div className="page-stack">
      <div className="q-notice">
        {result.comparable
          ? "对比条件记录一致，仍需多轮复测确认收益。"
          : `仅供趋势参考。条件不同：${result.condition_differences.join("、") || "无"}；条件缺失：${result.unknown_conditions.join("、") || "无"}`}
      </div>
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>文件 / 时间</th>
                {keys.map((key) => (
                  <th key={key}>{METRIC_LABELS[key] ?? key}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr key={row.id}>
                  <td>
                    {index === 0 && <span className="badge">基线</span>}
                    <strong>{row.filename}</strong>
                    <small>{new Date(row.created_at).toLocaleString()}</small>
                  </td>
                  {keys.map((key) => (
                    <td key={key}>
                      {numeric(row.values[key])}
                      {index > 0 && (
                        <small>
                          {row.delta_pct[key] === null
                            ? "无可用基线"
                            : `${numeric(row.delta_pct[key])}%`}
                        </small>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <label>
        对比指标
        <select
          value={metric}
          onChange={(event) => setMetric(event.target.value)}
        >
          {keys.map((key) => (
            <option key={key} value={key}>
              {METRIC_LABELS[key] ?? key}
            </option>
          ))}
        </select>
      </label>
      <Trend
        title={METRIC_LABELS[metric] ?? metric}
        points={points}
        metric={metric}
        caption="所选任务顺序（首项为基线）"
      />
      {result.warnings.map((value) => (
        <p className="q-help" key={value}>
          {value}
        </p>
      ))}
    </div>
  );
}

/** 作用：导入分析文件与采集条件；入参：类型、规则、提交和关闭回调；返回：上传表单。 */
function Upload({
  kind,
  rules,
  onUpload,
  onClose,
}: {
  kind: Kind;
  rules: Record<string, number>;
  onUpload: (files: File[], options: Record<string, unknown>) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  /** 作用：校验表单并顺序导入多文件；入参：提交事件；返回：无。 */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setBusy(true);
    const data = new FormData(event.currentTarget);
    const files = data
      .getAll("files")
      .filter((file): file is File => file instanceof File && file.size > 0);
    try {
      if (!files.length || files.length > 6)
        throw new Error("每次选择 1~6 个文件");
      if (files.some((file) => file.size > 1024 ** 3))
        throw new Error("单文件不能超过 1 GiB");
      const options: Record<string, unknown> = {
        kind,
        target_fps: Number(data.get("target_fps") || 60),
        sample_interval_s: Number(data.get("sample_interval_s") || 1),
      };
      for (const key of [
        "process_name",
        "device",
        "scene",
        "build",
        "graphics_api",
        "resolution",
        "quality",
        "probe",
      ])
        options[key] = String(data.get(key) || "");
      if (kind === "apk") {
        options.rules = rules;
        options.build_evidence = JSON.parse(
          String(data.get("build_evidence") || "{}"),
        );
      }
      await onUpload(files, options);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导入失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={kind === "performance" ? "导入性能数据" : "导入 APK 自检"}
      onClose={onClose}
      wide
    >
      <form className="stack" onSubmit={submit}>
        <label>
          选择文件（最多 6 个，单文件 ≤ 1 GiB，文本 ≤ 128 MiB）
          <input
            name="files"
            type="file"
            multiple
            required
            accept={
              kind === "apk"
                ? ".apk"
                : ".csv,.tsv,.json,.jsonl,.log,.txt,.pftrace,.perfetto-trace,.trace,.pb,.raw,.data"
            }
          />
        </label>
        {kind === "performance" ? (
          <>
            <div className="q-notice">
              CSV/JSON/日志自动识别。Perfetto 二进制需要配置官方 Trace
              Processor；Unity .raw 请使用配套 Editor 导出脚本先转 JSON。
            </div>
            <div className="three-cols">
              <label>
                目标 FPS
                <input
                  name="target_fps"
                  type="number"
                  min="1"
                  max="360"
                  defaultValue="60"
                  required
                />
              </label>
              <label>
                缺省采样间隔（秒）
                <input
                  name="sample_interval_s"
                  type="number"
                  min="0.0001"
                  max="60"
                  step="any"
                  defaultValue="1"
                  required
                />
              </label>
              <label>
                进程名（Trace 筛选）
                <input
                  name="process_name"
                  placeholder="com.example.game"
                  maxLength={200}
                />
              </label>
            </div>
            <div className="three-cols">
              {[
                ["device", "设备"],
                ["scene", "场景 / 关卡"],
                ["build", "构建版本"],
                ["graphics_api", "图形 API"],
                ["resolution", "分辨率"],
                ["quality", "画质档位"],
                ["probe", "探针模式"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input name={key} maxLength={200} />
                </label>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className="q-help">
              使用当前项目质量红线；规则随任务保存，后续修改不会改变历史报告。
            </p>
            <label>
              可选构建证据 JSON
              <textarea
                name="build_evidence"
                rows={7}
                placeholder={
                  '{"apk_sha256":"...","shader_variants":1000,"atlases":[]}'
                }
                maxLength={150000}
              />
            </label>
            <p className="q-help">
              未引用资源需完整引用清单、动态路径及 APK 哈希。仅上传 APK
              时，相关检查显示“未提供证据”。
            </p>
          </>
        )}
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "正在上传…" : "上传并分析"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 作用：渲染并保存质量红线；入参：当前规则、保存回调；返回：规则表单。 */
function Rules({
  rules,
  onSave,
}: {
  rules: Record<string, number>;
  onSave: (rules: Record<string, number>) => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  /** 作用：保存经服务端校验的规则；入参：表单事件；返回：无。 */
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const data = new FormData(event.currentTarget);
    try {
      await onSave(
        Object.fromEntries(
          Object.keys(RULE_LABELS).map((key) => [key, Number(data.get(key))]),
        ),
      );
      setMessage("规则已保存，对下一次导入生效。");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : "保存失败");
    }
  }
  return (
    <section className="panel q-section">
      <h3>项目质量红线</h3>
      <p className="q-help">
        MiB = 1024² 字节。违规项按 P0/P1/P2 标红或标黄并附优化建议。
      </p>
      <form className="stack" onSubmit={save}>
        <div className="three-cols">
          {Object.entries(RULE_LABELS).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                key={`${key}-${rules[key]}`}
                name={key}
                type="number"
                step="any"
                min="0.001"
                max={key === "atlas_min_fill_pct" ? 100 : 1000000}
                defaultValue={rules[key]}
                required
              />
            </label>
          ))}
        </div>
        {message && <p role="status">{message}</p>}
        <div className="actions">
          <button className="primary">保存质量红线</button>
        </div>
      </form>
    </section>
  );
}

/** 作用：接入性能/APK 分析工作台；入参：当前项目标识、模块类型；返回：历史、上传、对比及报告页面。 */
export function QualityAnalysis({
  projectId,
  kind,
}: {
  projectId: string;
  kind: Kind;
}) {
  const [jobs, setJobs] = useState<Job[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [job, setJob] = useState<Job | null>(null);
  const [report, setReport] = useState<Report | null>(null),
    [compare, setCompare] = useState<Compare | null>(null),
    [rules, setRules] = useState<Record<string, number>>({});
  const [view, setView] = useState("history"),
    [upload, setUpload] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  const base = `/api/projects/${projectId}/quality`;
  /** 作用：读取当前项目历史及规则；入参：无；返回：刷新完成的 Promise。 */
  const refresh = useCallback(async () => {
    const [history, config] = await Promise.all([
      api<{ items: Job[] }>(`${base}/jobs?kind=${kind}`),
      api<{ rules: Record<string, number> }>(`${base}/rules`),
    ]);
    setJobs(history.items);
    setRules(config.rules);
  }, [base, kind]);
  useEffect(() => {
    let active = true;
    setJobs([]);
    setJob(null);
    setReport(null);
    setCompare(null);
    setSelected([]);
    setView("history");
    setLoading(true);
    setError("");
    refresh()
      .catch((reason) => active && setError(reason.message))
      .finally(() => active && setLoading(false));
    const timer = setInterval(() => {
      if (active)
        void refresh().catch((reason) => active && setError(reason.message));
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh]);
  /** 作用：排队多文件分析；入参：文件列表和选项；返回：全部上传结束。 */
  async function importFiles(files: File[], options: Record<string, unknown>) {
    const config = await api<{ id: string }>(`${base}/configs`, {
      method: "POST",
      body: JSON.stringify(options),
    });
    for (const file of files) {
      await api<Job>(`${base}/jobs?kind=${kind}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Filename": encodeURIComponent(file.name),
          "X-Analysis-Config": config.id,
        },
        body: file,
      });
    }
    await refresh();
    setView("history");
  }
  /** 作用：打开已完成任务；入参：历史任务；返回：报告加载完成。 */
  async function openReport(value: Job) {
    setError("");
    try {
      const result = await api<Report>(`${base}/jobs/${value.id}/report`);
      setReport(result);
      setJob(value);
      setView("report");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "读取失败");
    }
  }
  /** 作用：比较选择任务；入参：无；返回：比较结果展示。 */
  async function compareSelected() {
    setError("");
    try {
      setCompare(
        await api<Compare>(`${base}/compare?ids=${selected.join(",")}`),
      );
      setView("compare");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "对比失败");
    }
  }
  /** 作用：删除用户指定的历史和原始文件；入参：任务；返回：刷新历史。 */
  async function deleteJob(value: Job) {
    if (
      !window.confirm(
        `删除 ${value.filename} 的历史、原始文件和报告？此操作不可恢复。`,
      )
    )
      return;
    try {
      await api(`${base}/jobs/${value.id}`, { method: "DELETE" });
      setSelected((current) => current.filter((id) => id !== value.id));
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "删除失败");
    }
  }
  /** 作用：保存当前项目规则；入参：规则字典；返回：更新后的本地规则。 */
  async function saveRules(value: Record<string, number>) {
    const result = await api<{ rules: Record<string, number> }>(
      `${base}/rules`,
      { method: "PUT", body: JSON.stringify(value) },
    );
    setRules(result.rules);
  }
  /** 作用：导出报告并显示错误；入参：JSON/HTML 格式；返回：无。 */
  async function exportReport(format: "json" | "html") {
    if (!job) return;
    try {
      await download(
        `${base}/jobs/${job.id}/${format === "html" ? "report.html" : "report"}`,
        `quality-${job.id}.${format}`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "导出失败");
    }
  }
  const title = kind === "performance" ? "性能监控分析" : "APK 包体自检";
  return (
    <div className="page-stack q-workspace">
      <PageHeader
        eyebrow={
          kind === "performance"
            ? "GAME PERFORMANCE LAB"
            : "PACKAGE QUALITY GATE"
        }
        title={title}
        description={
          kind === "performance"
            ? "从帧时间、内存、GC 和运行日志定位性能风险，保留采集条件与证据。"
            : "解析包体结构与资源占用，按项目质量红线识别违规资源。"
        }
        actions={
          <button className="primary" onClick={() => setUpload(true)}>
            ＋ {kind === "performance" ? "导入性能数据" : "导入 APK"}
          </button>
        }
      />
      <div className="view-tabs">
        <button
          className={view === "history" ? "active" : ""}
          onClick={() => setView("history")}
        >
          分析历史 <b>{jobs.length}</b>
        </button>
        {report && (
          <button
            className={view === "report" ? "active" : ""}
            onClick={() => setView("report")}
          >
            分析报告
          </button>
        )}
        {compare && (
          <button
            className={view === "compare" ? "active" : ""}
            onClick={() => setView("compare")}
          >
            多文件对比
          </button>
        )}
        {kind === "apk" && (
          <button
            className={view === "rules" ? "active" : ""}
            onClick={() => setView("rules")}
          >
            质量红线
          </button>
        )}
      </div>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      {loading && <p className="loading-state">正在连接分析服务…</p>}
      {view === "history" && (
        <>
          <div className="q-history-summary">
            <span>
              历史保留最近 100 项 · 同时最多 8 项排队 · 单任务最长 180 秒
            </span>
            <button
              disabled={selected.length < 2}
              onClick={() => void compareSelected()}
            >
              对比所选（{selected.length}/6）
            </button>
          </div>
          <section className="panel">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>对比</th>
                    <th>文件 / 导入时间</th>
                    <th>状态</th>
                    <th>格式 / 采样</th>
                    <th>风险</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((value) => (
                    <tr key={value.id}>
                      <td>
                        <input
                          aria-label={`选择对比 ${value.filename}`}
                          type="checkbox"
                          checked={selected.includes(value.id)}
                          disabled={
                            value.status !== "completed" ||
                            (!selected.includes(value.id) &&
                              selected.length >= 6)
                          }
                          onChange={(event) =>
                            setSelected((current) =>
                              event.target.checked
                                ? [...current, value.id]
                                : current.filter((id) => id !== value.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        <strong>{value.filename}</strong>
                        <small>
                          {new Date(value.created_at).toLocaleString()}
                        </small>
                        {value.error && (
                          <p className="q-bad q-task-error">{value.error}</p>
                        )}
                      </td>
                      <td>
                        <span className={`status status-${value.status}`}>
                          {STATUS[value.status]}
                        </span>
                      </td>
                      <td>
                        {value.summary?.format ?? "—"}
                        <small>
                          {kind === "performance"
                            ? `${value.summary?.sample_count ?? "—"} 采样`
                            : size(value.summary?.apk_bytes)}
                        </small>
                      </td>
                      <td>
                        <div className="q-levels">
                          {value.summary &&
                            ["P0", "P1", "P2"].map((level) => (
                              <span className={`q-level ${level}`} key={level}>
                                {level} {value.summary?.risk_counts[level] ?? 0}
                              </span>
                            ))}
                        </div>
                      </td>
                      <td>
                        <div className="q-row-actions">
                          <button
                            disabled={value.status !== "completed"}
                            onClick={() => void openReport(value)}
                          >
                            查看报告
                          </button>
                          <button
                            className="danger-link"
                            disabled={["queued", "running"].includes(
                              value.status,
                            )}
                            onClick={() => void deleteJob(value)}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!jobs.length && !loading && (
              <Empty
                title="还没有分析记录"
                description="导入游戏实机采样、运行日志或 APK，报告会保存在当前项目中。"
              />
            )}
          </section>
        </>
      )}
      {view === "rules" && <Rules rules={rules} onSave={saveRules} />}{" "}
      {view === "compare" && compare && <Comparison result={compare} />}{" "}
      {view === "report" && report && job && (
        <>
          <section className="q-report-heading">
            <div>
              <h3>{job.filename}</h3>
              <p>
                {new Date(job.created_at).toLocaleString()} · {report.format} ·
                分析器 {report.analyzer_version}
              </p>
            </div>
            <div className="q-row-actions">
              <button onClick={() => void exportReport("json")}>
                下载 JSON
              </button>
              <button onClick={() => void exportReport("html")}>
                离线 HTML / 打印
              </button>
            </div>
          </section>
          {kind === "performance" ? (
            <PerformanceReport report={report} />
          ) : (
            <ApkReport report={report} />
          )}
          <section className="panel q-section">
            <h3>数据口径与检测边界</h3>
            <ul>
              {[...(report.warnings ?? []), ...(report.notes ?? [])].map(
                (value, index) => (
                  <li key={index}>{value}</li>
                ),
              )}
            </ul>
            {!!report.missing_metrics?.length && (
              <p>
                未采集：
                {report.missing_metrics
                  .map((key) => METRIC_LABELS[key] ?? key)
                  .join("、")}
              </p>
            )}
          </section>
        </>
      )}
      {upload && (
        <Upload
          kind={kind}
          rules={rules}
          onUpload={importFiles}
          onClose={() => setUpload(false)}
        />
      )}
    </div>
  );
}
