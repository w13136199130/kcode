param(
  [ValidateSet("verify", "install", "uninstall")]
  [string]$Action = "verify",
  [switch]$GrantProfileRead,
  [switch]$Yes
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $root
$srtBin = Join-Path $root "packages/sandbox/node_modules/.bin/srt.CMD"
if (-not (Test-Path $srtBin)) {
  throw "srt CLI not found at $srtBin. Run: pnpm install"
}

function Invoke-Srt {
  param([string[]]$SrtArgs)
  & $srtBin @SrtArgs
  if ($LASTEXITCODE -ne 0) {
    throw "srt command failed (exit $LASTEXITCODE): srt $($SrtArgs -join ' ')"
  }
}

function Invoke-SrtCapture {
  param([string[]]$SrtArgs)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $srtBin @SrtArgs 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return @{ code = $code; output = ($output -join "`n") }
}

function Confirm-Action([string]$Message) {
  if ($Yes) { return }
  $answer = Read-Host "$Message [y/N]"
  if ($answer -notmatch "^(?i)y(es)?$") {
    throw "cancelled"
  }
}

if ($Action -eq "install") {
  $installArgs = @("windows-install")
  if (-not $GrantProfileRead) {
    $installArgs += "--skip-profile-grant"
    Write-Host "Profile read grant: SKIPPED (recommended; sandbox can read only explicitly granted paths)."
  } else {
    Write-Host "Profile read grant: ENABLED (sandbox can read your profile except credential stores)."
  }
  Write-Host "Installing srt Windows sandbox. This opens ONE UAC prompt and changes machine-wide WFP filters."
  Confirm-Action "Proceed with srt windows-install?"
  Invoke-Srt $installArgs
  Write-Host "Installed. Next: set KCODE_SANDBOX=srt and run /sandbox in kcode."
  exit 0
}

if ($Action -eq "uninstall") {
  Write-Host "This removes the srt-sandbox account and machine-wide WFP filters."
  Confirm-Action "Proceed with srt windows-uninstall?"
  Invoke-Srt @("windows-uninstall")
  Write-Host "Uninstalled."
  exit 0
}

# verify: run srt directly against a FIXED workspace. Fixed path matters:
# srt keeps a persistent write root per cwd; a random deleted temp root can
# make the next ACL grant wait on a missing volume. Reuse one directory.
$work = Join-Path $env:TEMP "kcode-srt-verify"
$settings = Join-Path $work "srt-settings.json"
$systemProbe = "C:\Windows\kcode-srt-verify.txt"
New-Item -ItemType Directory -Force -Path $work | Out-Null
Get-ChildItem -LiteralPath $work -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $systemProbe -ErrorAction SilentlyContinue

try {
  $config = @{
    filesystem = @{
      allowWrite = @($work)
      denyWrite  = @()
      denyRead   = @()
    }
    network = @{
      allowedDomains = @()
      deniedDomains  = @()
    }
  }
  $json = $config | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText($settings, $json, (New-Object System.Text.UTF8Encoding($false)))

  Push-Location $work
  Write-Host "workspace: $work"
  Write-Host "Checking srt install status by running a trivial command..."
  $trivial = Invoke-SrtCapture @("--settings", $settings, "-c", "echo SANDBOX_BOOT_OK")
  if ($trivial.code -ne 0) {
    throw "srt cannot launch a command. Is the sandbox installed? Run: powershell -File scripts/srt-sandbox.ps1 -Action install`n$($trivial.output)"
  }
  Write-Host "[PASS] srt launches a command"

  $write = Invoke-SrtCapture @("--settings", $settings, "-c", "echo SANDBOX_OK>verify-workspace.txt")
  if ($write.code -ne 0 -or -not (Test-Path (Join-Path $work "verify-workspace.txt"))) {
    throw "workspace write failed. $($write.output)"
  }
  Write-Host "[PASS] workspace write"

  $system = Invoke-SrtCapture @("--settings", $settings, "-c", "echo NOPE>$systemProbe 2>system-write-error.txt")
  $systemExists = Test-Path $systemProbe
  if ($systemExists) {
    Remove-Item $systemProbe -ErrorAction SilentlyContinue
    throw "SYSTEM WRITE SUCCEEDED; srt is not enforcing the system-directory boundary."
  }
  Write-Host "[PASS] C:\Windows write denied"

  $hasCurl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($null -eq $hasCurl) {
    Write-Host "[SKIP] curl.exe not found; network check skipped"
  } else {
    $net = Invoke-SrtCapture @("--settings", $settings, "-c", "curl.exe -s -m 5 https://example.com")
    if ($net.code -eq 0) {
      throw "NETWORK SUCCEEDED with allowedDomains=[]; srt network fence is not enforcing deny."
    }
    Write-Host "[PASS] network denied (curl exit $($net.code))"
  }

  $tools = Invoke-SrtCapture @("--settings", $settings, "-c", "node -v && git --version")
  if ($tools.code -eq 0) {
    Write-Host "[PASS] node/git available under srt"
  } else {
    Write-Host "[WARN] node/git not both available under srt (exit $($tools.code)); inspect PATH/toolchain before enabling for daily use."
  }

  Write-Host ""
  Write-Host "VERIFY SUMMARY: boot/workspace/system/network checks passed."
  Write-Host "Next: set KCODE_SANDBOX=srt, start kcode, run /sandbox."
} finally {
  Pop-Location
  Remove-Item $systemProbe -ErrorAction SilentlyContinue
  # Keep $work: it is the stable srt write-root. Clear file contents only.
  Get-ChildItem -LiteralPath $work -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}
