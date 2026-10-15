# Security Policy

## 禁止提交的内容

- `.env`、数据库备份、附件、日志；
- API Token、Cookie、密码、私钥；
- 内部域名、内网 IP、真实人员名单；
- 从公司仓库复制出的 Git 历史或专用业务代码；
- 生产截图、导出表格和真实项目数据。

## 发布前检查

公开仓库提交前，为当前仓库设置通用身份（不会修改其他仓库或全局配置）：

```powershell
git config --local user.name "Community Contributor"
git config --local user.email "community@example.com"
.\scripts\check-public-safety.ps1
```

安全扫描同时检查文件内容、全部可达提交的作者/提交者邮箱和当前生效的提交身份。
仅允许示例邮箱或 GitHub noreply 邮箱。不要把真实邮箱放入提交说明、签署行或注释。

```powershell
rg -n -i "password\s*=|token\s*=|secret\s*=|172\.16\.|internal\.com" . \
  --glob "!node_modules/**" --glob "!package-lock.json" --glob "!.env.example"
git log --all --oneline
git status --short
```

命中不一定代表泄密，但必须逐项核对。若秘密曾经进入 Git 历史，仅删除当前文件不够，必须立即吊销秘密并重建干净仓库历史。

历史匿名化后，协作者应重新克隆，避免合并或推送旧历史导致个人信息重新出现。
强制更新分支并不保证 GitHub 已立即删除旧 SHA 的缓存视图；需要额外核查，并按 GitHub 官方流程申请平台清理。
参见 [GitHub 历史数据清理说明](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository)。

## 漏洞报告

请通过仓库私有安全渠道提交，不要在公开 Issue 中粘贴 Token、日志或个人数据。

