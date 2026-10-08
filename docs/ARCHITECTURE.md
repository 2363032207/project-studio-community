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

- `frontend`：登录、项目切换、总览、需求、Bug、版本、测试用例；
- `backend/src/app.ts`：HTTP API 与权限入口；
- `backend/src/auth.ts`：密码哈希和随机会话 Token；
- `backend/src/database.ts`：数据库连接和迁移；
- `backend/migrations`：从空数据库可执行的完整结构；
- `docker-compose.yml`：数据库、API、Web 三个容器。

## 权限模型

- `admin`：可以创建项目和查看用户；
- `owner`：项目负责人，可以修改项目与成员；
- `member`：项目成员，可以管理工作项、版本和测试用例；
- `viewer`：只读访问。

所有写操作都由后端校验权限，不能只依赖前端隐藏按钮。

## 数据持久化

PostgreSQL 数据保存在 Docker 命名卷 `postgres-data`。迁移按文件名顺序执行，并记录 SHA-256；已执行迁移被修改时服务会拒绝启动，避免数据库结构悄悄漂移。

