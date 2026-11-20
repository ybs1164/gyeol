param(
    [int]$Workers = 6,
    [string]$OutputDirectory = 'tools/calibration/cognition-v1',
    [switch]$Status
)
$ErrorActionPreference = 'Stop'
$projectPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$batchPath = [System.IO.Path]::GetFullPath((Join-Path $projectPath $OutputDirectory))
$progressPath = Join-Path $batchPath 'progress.json'
if ($Status) {
    if (Test-Path -LiteralPath $progressPath) { Get-Content -LiteralPath $progressPath -Encoding UTF8 }
    else { Write-Output 'Batch has not started.' }
    exit 0
}
if ($Workers -lt 1 -or $Workers -gt 16) { throw 'Workers must be between 1 and 16.' }
New-Item -ItemType Directory -Path $batchPath -Force | Out-Null
$lockPath = Join-Path $batchPath 'run.lock'
if (Test-Path -LiteralPath $lockPath) {
    $lockData = Get-Content -LiteralPath $lockPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $existingProcess = Get-Process -Id $lockData.pid -ErrorAction SilentlyContinue
    if ($existingProcess) {
        Write-Output "Batch process $($lockData.pid) is already running."
        if (Test-Path -LiteralPath $progressPath) { Get-Content -LiteralPath $progressPath -Encoding UTF8 }
        exit 0
    }
    Remove-Item -LiteralPath $lockPath
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$stdoutPath = Join-Path $batchPath "runner-$stamp.stdout.log"
$stderrPath = Join-Path $batchPath "runner-$stamp.stderr.log"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$runnerPath = Join-Path $projectPath 'tools/calibrate_cognitive_bots.ts'
# Windows argument quoting: these controlled paths cannot contain embedded double quotes.
$batchArguments = @('--import', 'tsx', ('"' + $runnerPath + '"'), '--workers', [string]$Workers,
    '--out', ('"' + $batchPath + '"'), '--rounds', '50', '--validation-rounds', '10')
$batchProcess = Start-Process -FilePath $nodePath -ArgumentList $batchArguments -WorkingDirectory $projectPath `
    -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
$launchData = @{ pid = $batchProcess.Id; launchedAt = (Get-Date).ToString('o'); workers = $Workers;
    outputDirectory = $batchPath; stdout = $stdoutPath; stderr = $stderrPath }
$launchData | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $batchPath 'launch.json') -Encoding UTF8
$launchData | ConvertTo-Json
