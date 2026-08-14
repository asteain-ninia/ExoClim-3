# このリポジトリの計算が実際に走っているかを数える。Stop フックの補助。
#
# タスク出力の更新時刻だけで待機を判定すると、出力を out/ へリダイレクトした
# ジョブが「静かに走っている」あいだ寝落ちと誤判定される(2026-08-14 に実害)。
# 口先ではなく実物のプロセスを数える。
$ErrorActionPreference = 'SilentlyContinue'
$n = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -like '*ExoClim-3*' -and (
        $_.CommandLine -like '*tsx*' -or
        $_.CommandLine -like '*vitest*' -or
        $_.CommandLine -like '*optimize*'
    )
}).Count
Write-Output $n
