# Project Studio Community

一个通用项目与测试管理系统。

## 功能

- 账号登录与会话管理；
- 项目与项目成员；
- 项目健康总览、里程碑、版本和时间轴排期；
- 需求与 Bug 全生命周期管理，包含验收标准、严重级别、环境和复现信息；
- 测试用例库、用例套件、需求覆盖矩阵；
- 测试计划、执行结果和质量报告；
- 项目审计记录；
- PostgreSQL 持久化；
- Docker Compose 一键启动。

## 快速启动

前置条件：Docker Desktop。

```powershell
Copy-Item .env.example .env
notepad .env
docker compose up --build -d
```

修改 `.env` 中的数据库密码、`APP_SECRET` 和管理员密码后再启动。

访问：

- Web：http://127.0.0.1:8088
- API 健康检查：http://127.0.0.1:8088/api/health

使用 `.env` 中的 `APP_ADMIN_EMAIL` / `APP_ADMIN_PASSWORD` 登录。首次启动会自动创建管理员；后续修改环境变量不会覆盖已存在账号的密码。

新建项目后，可以在项目总览点击“生成演示数据”，填充一套完全虚构的需求、问题、里程碑、排期、测试套件和测试计划。该操作只写入本地数据库，不连接任何公司系统。

停止：

```powershell
docker compose down
```

删除本地演示数据：

```powershell
docker compose down -v
```

上述命令会永久删除本项目的 Docker 数据卷，仅用于确认不再需要本地数据时。

## 本地开发

需要 Node.js 22+ 和 PostgreSQL 16。

后端：

```powershell
Set-Location backend
Copy-Item .env.example .env
npm ci
npm run dev
```

前端：

```powershell
Set-Location frontend
npm ci
npm run dev
```

开发页面：http://127.0.0.1:5173。Vite 会把 `/api` 代理到 `127.0.0.1:8080`。

## 安全边界

- 仅提交 `.env.example`，不要提交 `.env`；
- 示例账号、项目和域名必须使用虚构数据；
- 部署公网前必须启用 HTTPS、反向代理、备份、日志留存和登录限流；
- 当前版本适合个人/小团队内网使用；互联网生产部署前应接入成熟身份系统并完成安全评审；
- 不要把任何公司数据库、附件或 Git 历史复制到本仓库。

演示数据使用 `example.com`、通用项目名称和虚构业务场景，不包含公司、客户、产品、账号或内部地址标识。

更多说明见 [SECURITY.md](SECURITY.md) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

公开仓库前执行：

```powershell
.\scripts\check-public-safety.ps1
```
