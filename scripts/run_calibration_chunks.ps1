# 自動較正を複数チャンクに分けて連続実行する(長時間の無人運転用)。
# 各チャンクは state を保存して終了するため、途中で落ちても損失は 1 バッチ分。
# 使い方: pwsh -File scripts/run_calibration_chunks.ps1 -Run v5crest -Chunks 8 -Minutes 55 -Parallel 9
param(
  [Parameter(Mandatory = $true)][string]$Run,
  [int]$Chunks = 8,
  [int]$Minutes = 55,
  [int]$Parallel = 9
)
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
for ($i = 1; $i -le $Chunks; $i++) {
  $stamp = (Get-Date).ToString('HH:mm:ss', [System.Globalization.CultureInfo]::InvariantCulture)
  Write-Output "[$stamp] チャンク $i / $Chunks 開始 (run=$Run)"
  npx tsx scripts/optimize.ts --run $Run --minutes $Minutes --parallel $Parallel 2>&1 |
    Select-Object -Last 1 | ForEach-Object { Write-Output "  $_" }
}
Write-Output "全チャンク完了 (run=$Run)"
