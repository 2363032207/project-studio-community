"""SQLite 任务历史与质量红线持久化。每次操作使用独立连接，适配线程请求。"""

import json
import sqlite3
from pathlib import Path


class Store:
    """任务元信息存储，原始文件和完整报告保存在单独的任务目录。"""

    def __init__(self, root):
        """作用：初始化数据库；入参：数据目录；返回：Store 实例。"""
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "quality.sqlite3"
        with self.connection() as db:
            db.executescript("""
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
                filename TEXT NOT NULL, status TEXT NOT NULL, options TEXT NOT NULL,
                summary TEXT, error TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
              CREATE INDEX IF NOT EXISTS jobs_project ON jobs(project_id,created_at);
              CREATE TABLE IF NOT EXISTS rules (project_id TEXT PRIMARY KEY, body TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS configs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL,
                created_at INTEGER NOT NULL DEFAULT (unixepoch()));
            """)
            db.execute("UPDATE jobs SET status='failed',error='服务重启中断了任务，请重新上传' WHERE status IN ('queued','running')")

    def connection(self):
        """作用：创建独立连接；入参：无；返回：行字典模式 SQLite 连接。"""
        db = sqlite3.connect(self.path, timeout=15)
        db.row_factory = sqlite3.Row
        return db

    def create(self, job_id, project_id, kind, filename, options):
        """作用：登记任务；入参：任务/项目标识、类型、文件名、参数；返回：无。"""
        with self.connection() as db:
            db.execute("INSERT INTO jobs(id,project_id,kind,filename,status,options) VALUES (?,?,?,?,'queued',?)",
                       (job_id, project_id, kind, filename, json.dumps(options)))

    def update(self, job_id, status, summary=None, error=None):
        """作用：更新任务状态；入参：任务标识、状态、摘要、错误；返回：无。"""
        with self.connection() as db:
            db.execute("UPDATE jobs SET status=?,summary=?,error=? WHERE id=?",
                       (status, json.dumps(summary, ensure_ascii=False) if summary is not None else None, error, job_id))

    def get(self, project_id, job_id):
        """作用：按项目隔离读取任务；入参：项目/任务标识；返回：字典或 None。"""
        with self.connection() as db:
            row = db.execute("SELECT * FROM jobs WHERE project_id=? AND id=?", (project_id, job_id)).fetchone()
            return self.decode(row) if row else None

    def list(self, project_id, kind):
        """作用：读取最近 100 次历史；入参：项目标识和类型；返回：任务字典列表。"""
        with self.connection() as db:
            return [self.decode(row) for row in db.execute("SELECT * FROM jobs WHERE project_id=? AND kind=? ORDER BY created_at DESC LIMIT 100", (project_id, kind))]

    @staticmethod
    def decode(row):
        """作用：解码数据库 JSON；入参：SQLite 行；返回：可序列化任务字典。"""
        result = dict(row)
        for key in ("options", "summary"):
            result[key] = json.loads(result[key]) if result[key] else None
        return result

    def rules(self, project_id, value=None):
        """作用：读写项目质量规则；入参：项目标识及可选规则；返回：当前自定义规则。"""
        with self.connection() as db:
            if value is not None:
                db.execute("INSERT INTO rules VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET body=excluded.body", (project_id, json.dumps(value)))
            row = db.execute("SELECT body FROM rules WHERE project_id=?", (project_id,)).fetchone()
            return json.loads(row[0]) if row else {}

    def config(self, project_id, config_id=None, value=None):
        """作用：保存/读取一小时有效上传配置；入参：项目、配置标识、可选参数；返回：配置 ID 或参数。"""
        import uuid
        with self.connection() as db:
            db.execute("DELETE FROM configs WHERE created_at<unixepoch()-3600")
            if value is not None:
                config_id = str(uuid.uuid4())
                db.execute("INSERT INTO configs(id,project_id,body) VALUES (?,?,?)", (config_id, project_id, json.dumps(value)))
                return config_id
            row = db.execute("SELECT body FROM configs WHERE id=? AND project_id=?", (config_id, project_id)).fetchone()
            if not row:
                raise ValueError("上传配置不存在或已过期，请重新提交")
            return json.loads(row[0])
