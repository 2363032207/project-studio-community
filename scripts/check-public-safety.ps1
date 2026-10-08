$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$forbiddenFiles = @(
  '.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.db', '*.sqlite', '*.sqlite3',
  '*.bak', '*.dump', '*.tar', '*.zip'
)
$trackedFiles = @(& git ls-files)
if ($LASTEXITCODE -ne 0) { throw '无法读取 Git 跟踪文件列表。' }
$foundFiles = foreach ($pattern in $forbiddenFiles) {
  $trackedFiles | Where-Object { (Split-Path $_ -Leaf) -like $pattern }
}
if ($foundFiles) {
  Write-Error ("发现禁止公开的 Git 跟踪文件：`n" + (($foundFiles | Sort-Object -Unique) -join "`n"))
}

$rg = Get-Command rg -ErrorAction SilentlyContinue
if (-not $rg) { throw '需要安装 ripgrep (rg) 才能执行文本安全扫描。' }

$excluded = @('--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!package-lock.json', '--glob', '!scripts/check-public-safety.ps1')
$patterns = @(
  'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY',
  '(github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}',
  'glpat-[A-Za-z0-9_-]{12,}',
  'sntryu_[A-Za-z0-9_]{20,}',
  'AKIA[0-9A-Z]{16}',
  'Bearer\s+[A-Za-z0-9._~+/-]{20,}',
  '[A-Za-z]:[\\/]Users[\\/]',
  '(^|[^0-9])(10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|192\.168\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})([^0-9]|$)'
)
$hits = @()
foreach ($pattern in $patterns) {
  $result = & $rg.Source '-n' '-i' @excluded $pattern '.' 2>$null
  if ($LASTEXITCODE -eq 0) { $hits += $result }
  elseif ($LASTEXITCODE -ne 1) { throw "文本扫描失败：$pattern" }
}
if ($hits) { Write-Error ("发现需要人工复核的敏感内容：`n" + ($hits -join "`n")) }

$emailHits = & $rg.Source '-n' '-i' @excluded '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}' '.' 2>$null
if ($LASTEXITCODE -notin 0, 1) { throw '邮箱扫描失败。' }
$nonExampleEmails = @($emailHits | Where-Object { $_ -notmatch '(?i)@example\.(com|org|net)(\b|$)' })
if ($nonExampleEmails) { Write-Error ("发现可能属于个人或组织的邮箱：`n" + ($nonExampleEmails -join "`n")) }

$localPatternFile = Join-Path $root 'scripts/public-safety.local-patterns.txt'
if (Test-Path $localPatternFile) {
  foreach ($pattern in Get-Content $localPatternFile) {
    $pattern = $pattern.Trim()
    if (-not $pattern -or $pattern.StartsWith('#')) { continue }
    $result = & $rg.Source '-n' '-i' @excluded $pattern '.' 2>$null
    if ($LASTEXITCODE -eq 0) { Write-Error ("发现本地禁止公开的标识：`n" + ($result -join "`n")) }
    elseif ($LASTEXITCODE -ne 1) { throw '本地标识扫描失败。' }
  }
}

Write-Host '公开安全扫描通过：未发现个人邮箱、私网地址、密钥或归档文件。' -ForegroundColor Green
