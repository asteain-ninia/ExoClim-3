# 自走モニタを常駐で立ち上げてブラウザを開く。
# 端末を閉じても残るように、切り離した窓なしプロセスで起動する。
#
#   powershell -ExecutionPolicy Bypass -File scripts\monitor.ps1
#
# すでに立っていればブラウザを開くだけ。詳細は docs/道具_自走モニタ_2026-08-24.md。

$ErrorActionPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:EXOCLIM_MONITOR_PORT) { $env:EXOCLIM_MONITOR_PORT } else { '7420' }
$url = "http://127.0.0.1:$port"

$alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like '*monitor_server.mjs*'
  }).Count

if ($alive -gt 0) {
  Write-Output "すでに起動しています ($alive 本): $url"
} else {
  $env:EXOCLIM_MONITOR_OPEN = '0'   # 開くのはこの script の役目
  Start-Process -FilePath 'node.exe' `
    -ArgumentList 'scripts/monitor_server.mjs' `
    -WorkingDirectory $root `
    -WindowStyle Hidden
  Start-Sleep -Milliseconds 900
  Write-Output "起動しました: $url"
}

Start-Process $url
