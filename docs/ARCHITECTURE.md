# 架构说明

```text
Browser
  │
  ▼
React + Vite / Nginx
  │ /api
  ▼
Fastify + TypeScript
  │
  ▼
PostgreSQL 16
```

## 模块

- `frontend`：登录、项目切换、总览、需求、问题、版本、里程碑、排期、测试资产、测试执行、质量报告和审计；
- `backend/src/app.ts`：HTTP API 与权限入口；
- `backend/src/extended.ts`：里程碑、排期、测试套件、测试计划、覆盖矩阵、质量报告与虚构演示数据 API；
- `backend/src/auth.ts`：密码哈希和随机会话 Token；
- `backend/src/database.ts`：数据库连接和迁移；
- `backend/migrations`：从空数据库可执行的完整结构；
- `docker-compose.yml`：数据库、API、Web 三个容器。

## 主要数据关系

```text
Project
  ├─ Version ─ Milestone
  ├─ WorkItem (Requirement / Bug)
  │    └─ Schedule
  ├─ TestSuite ─ TestCase ─ Requirement coverage
  └─ TestPlan ─ TestPlanCase execution
```

- 工作项编号和测试用例编号由数据库按项目自动分配；
- 测试用例可以关联一个套件和多个需求；
- 测试计划保存目标环境、版本、时间范围及每条用例的执行结果；
- 质量报告由实时聚合数据生成，不维护重复统计表；
- 关键写操作进入 `audit_logs`，便于追踪修改来源。

## 权限模型

- `admin`：可以创建项目和查看用户；
- `owner`：项目负责人，可以修改项目与成员；
- `member`：项目成员，可以管理工作项、版本和测试用例；
- `viewer`：只读访问。

所有写操作都由后端校验权限，不能只依赖前端隐藏按钮。

## 数据持久化

PostgreSQL 数据保存在 Docker 命名卷 `postgres-data`。迁移按文件名顺序执行，并记录 SHA-256；已执行迁移被修改时服务会拒绝启动，避免数据库结构悄悄漂移。
