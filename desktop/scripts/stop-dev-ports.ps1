$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$ports = @(5173, 8765)
$desktopRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$tauriExe = Join-Path $desktopRoot "src-tauri\target\debug\animal-detection-workbench.exe"

function Stop-DevProcess {
  param(
    [Parameter(Mandatory = $true)]
    [int]$ProcessId,
    [string]$Reason = "dev process"
  )

  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) {
    return
  }

  Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "Stopped $Reason process $ProcessId ($($process.ProcessName))"
}

foreach ($port in $ports) {
  $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    $processId = $listener.OwningProcess
    if (-not $processId) {
      continue
    }

    Stop-DevProcess -ProcessId $processId -Reason "port $port"
  }
}

if (Test-Path $tauriExe) {
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $tauriExe } |
    ForEach-Object { Stop-DevProcess -ProcessId $_.Id -Reason "Tauri app" }
}

$srcTauriPath = (Resolve-Path (Join-Path $desktopRoot "src-tauri")).Path
Get-CimInstance Win32_Process -Filter "Name = 'cargo.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$srcTauriPath*" } |
  ForEach-Object {
    Stop-DevProcess -ProcessId $_.ProcessId -Reason "Cargo watcher"
  }

foreach ($port in $ports) {
  $remaining = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  if ($remaining) {
    Write-Error "Port $port is still in use."
  } else {
    Write-Output "Port $port is free."
  }
}
