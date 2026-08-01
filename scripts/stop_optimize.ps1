# 較正を安全に止める。実行名で親と子をまとめて狙い撃ちする。
#
# 背景(2026-08-02 の実害): 親プロセスだけを kill すると
# optimize_worker の子が生き残り、GPU と CPU を食い続ける。
# 8 個の孤児が評価速度を 3 倍遅くしていたのに気付くまで数時間かかった。
# `pkill -f` は Windows では当てにならないので、コマンドラインの目印で選ぶ。
#
# 使い方:
#   pwsh -File scripts/stop_optimize.ps1 -Run v9sym
#   pwsh -File scripts/stop_optimize.ps1 -All      # 全部の較正を止める

param(
  [string]$Run = '',
  [switch]$All
)

$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and (
    $_.CommandLine -like '*scripts/optimize.ts*' -or
    $_.CommandLine -like '*scripts\optimize.ts*' -or
    $_.CommandLine -like '*optimize_worker*'
  )
}

if (-not $All) {
  if ([string]::IsNullOrEmpty($Run)) {
    Write-Output '実行名を -Run で指定するか、-All を付けること'
    exit 1
  }
  $procs = $procs | Where-Object {
    $_.CommandLine -like "*--marker=$Run*" -or $_.CommandLine -like "*--run $Run*"
  }
}

if (-not $procs) {
  Write-Output '該当するプロセスは無い'
  exit 0
}
foreach ($p in $procs) {
  Write-Output ("停止 PID {0}" -f $p.ProcessId)
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
  $_.CommandLine -and $_.CommandLine -like '*optimize_worker*'
}
Write-Output ("残っている optimize_worker: {0}" -f ($left | Measure-Object).Count)
