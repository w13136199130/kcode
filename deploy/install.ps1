# kcode 安装器（Windows PowerShell）：本地 tar 包或 URL → sha256 校验 → 解包 ~/.kcode/releases/<name> → 启动器 ~/.kcode/bin
# 用法：.\install.ps1 <tar.gz 路径或 URL> [latest.json 路径或 URL]
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Meta = ""
)
$ErrorActionPreference = "Stop"
$KcodeHome = if ($env:KCODE_HOME) { $env:KCODE_HOME } else { Join-Path $env:USERPROFILE ".kcode" }
$BinDir = Join-Path $KcodeHome "bin"
$RelDir = Join-Path $KcodeHome "releases"

function Fail($msg) { Write-Host "✗ $msg" -ForegroundColor Red; exit 1 }

# Node ≥22
try { $nodeVer = (node -v) } catch { Fail "缺少 node（https://nodejs.org 安装 ≥22）" }
if ([version]($nodeVer -replace '^v', '') -lt [version]"22.0.0") { Fail "需要 Node ≥22（当前 $nodeVer）" }

$tmp = New-Item -ItemType Directory -Force -Path (Join-Path $env:TEMP ([System.IO.Path]::GetRandomFileName()))
try {
  # 取包（本地或 URL）
  $pkg = Join-Path $tmp "pkg.tar.gz"
  if ($Source -match '^https?://') { Invoke-WebRequest -Uri $Source -OutFile $pkg -UseBasicParsing }
  else { Copy-Item $Source $pkg }

  # sha256：优先 latest.json / 同目录 .sha256
  $expected = $null
  if ($Meta -ne "") {
    $metaFile = Join-Path $tmp "meta"
    if ($Meta -match '^https?://') { Invoke-WebRequest -Uri $Meta -OutFile $metaFile -UseBasicParsing }
    else { Copy-Item $Meta $metaFile }
    $metaRaw = Get-Content $metaFile -Raw
    try {
      # latest.json（取 sha256 字段）；.sha256 文本（首列十六进制）——按内容识别
      $expected = ($metaRaw | ConvertFrom-Json).sha256
    } catch {
      $expected = ($metaRaw -split '\s+')[0]
    }
    if ($expected -notmatch '^[0-9a-f]{64}$') { $expected = $null }
  } elseif (Test-Path "$Source.sha256") {
    $expected = ((Get-Content "$Source.sha256" -Raw) -split '\s+')[0]
  }
  if ($expected) {
    $actual = (Get-FileHash $pkg -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { Fail "sha256 校验失败（期望 $expected，实际 $actual）" }
    Write-Host "✓ sha256 校验通过"
  } else {
    Write-Host "⚠ 未提供校验源（.sha256 / latest.json），跳过校验" -ForegroundColor Yellow
  }

  # 解包（Win10+ 自带 bsdtar）
  # 发行名取原始来源（本地路径或 URL 末段），不是 fetch 后的临时副本名
  $srcName = ($Source -split '[\\/]')[-1]
  $relName = $srcName -replace '\.tar\.gz$', '' -replace '\.tgz$', ''
  New-Item -ItemType Directory -Force -Path $RelDir, $BinDir | Out-Null
  if (Test-Path (Join-Path $RelDir $relName)) { Remove-Item (Join-Path $RelDir $relName) -Recurse -Force }
  # 显式用系统 bsdtar（PATH 里的 GNU/MSYS tar 对 Windows 路径与 -C 组合不兼容）
  $bsdtar = Join-Path $env:SystemRoot "System32\tar.exe"
  & $bsdtar -xzf $pkg -C $RelDir
  if ($LASTEXITCODE -ne 0) { Fail "解包失败（tar 退出码 $LASTEXITCODE）" }
  if (-not (Test-Path (Join-Path (Join-Path $RelDir $relName) "kcode.mjs"))) { Fail "包结构异常：缺 kcode.mjs" }

  # current 指针 + 启动器（kcode.cmd / kcode.ps1）
  $current = Join-Path $RelDir "current"
  if (Test-Path $current) { Remove-Item $current -Recurse -Force }
  New-Item -ItemType Junction -Path $current -Target (Join-Path $RelDir $relName) | Out-Null
  $entry = Join-Path $current "kcode.mjs"
  "@echo off`r`nchcp 65001 >nul`r`nnode `"$entry`" %*" | Set-Content (Join-Path $BinDir "kcode.cmd") -Encoding ASCII
  "node `"$entry`" @args" | Set-Content (Join-Path $BinDir "kcode.ps1") -Encoding UTF8

  Write-Host "✓ 已安装 $relName → $RelDir\$relName"
  Write-Host "  启动器：$BinDir\kcode.cmd（确保在 PATH 中：`$env:Path += `";$BinDir`"）"
  & node $entry --version
  Write-Host "✓ 安装完成。运行：kcode `"你的问题`""
} finally {
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
