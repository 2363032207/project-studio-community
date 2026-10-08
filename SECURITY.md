# Security Policy

## 禁止提交的内容

- `.env`、数据库备份、附件、日志；
- API Token、Cookie、密码、私钥；
- 内部域名、内网 IP、真实人员名单；
- 从公司仓库复制出的 Git 历史或专用业务代码；
- 生产截图、导出表格和真实项目数据。

## 发布前检查

```powershell
rg -n -i "password\s*=|token\s*=|secret\s*=|172\.16\.|internal\.com" . \
  --glob "!node_modules/**" --glob "!package-lock.json" --glob "!.env.example"
git log --all --oneline
git status --short
```

命中不一定代表泄密，但必须逐项核对。若秘密曾经进入 Git 历史，仅删除当前文件不够，必须立即吊销秘密并重建干净仓库历史。

## 漏洞报告

请通过仓库私有安全渠道提交，不要在公开 Issue 中粘贴 Token、日志或个人数据。

