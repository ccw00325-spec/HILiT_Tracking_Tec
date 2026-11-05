# 이 PC에서 도용 감시를 매주 돌리는 예약 작업을 등록합니다. 새 항목이 있으면 보고서 파일과 Windows 알림을 남깁니다.
#   pwsh tools/watch-install-windows.ps1 -StateDir <비공개 폴더> [-ExtraTerm <검색어>]...
# 지우기: Unregister-ScheduledTask -TaskName HILiT-Copy-Watch -Confirm:$false
param(
  [Parameter(Mandatory = $true)][string]$StateDir,
  [string[]]$ExtraTerm = @()
)
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force $StateDir | Out-Null
$runner = Join-Path $StateDir 'run-watch.ps1'
$termArgs = ($ExtraTerm | ForEach-Object { "'--term','$_'" }) -join ','
if ($termArgs) { $termArgs = ",$termArgs" }
@"
`$stamp = Get-Date -Format 'yyyy-MM-dd'
`$report = Join-Path '$StateDir' "watch-`$stamp.txt"
`$args = @('$repo\tools\watch-github.mjs','--state','$StateDir\state.json'$termArgs)
`$out = & node @args 2>&1 | Out-String
`$code = `$LASTEXITCODE
Set-Content -Path `$report -Value `$out -Encoding utf8
if (`$code -eq 1) {
  Add-Type -AssemblyName System.Windows.Forms
  `$n = New-Object System.Windows.Forms.NotifyIcon
  `$n.Icon = [System.Drawing.SystemIcons]::Warning
  `$n.Visible = `$true
  `$n.ShowBalloonTip(30000, 'HILiT 도용 감시', "새 항목이 있습니다: `$report", 'Warning')
  Start-Sleep -Seconds 30
  `$n.Dispose()
}
"@ | Set-Content -Path $runner -Encoding utf8
$action = New-ScheduledTaskAction -Execute 'pwsh.exe' -Argument "-NoProfile -WindowStyle Hidden -File `"$runner`""
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 10am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
Register-ScheduledTask -TaskName 'HILiT-Copy-Watch' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output "등록했습니다: 매주 월요일 10시, 보고서 폴더 $StateDir"
