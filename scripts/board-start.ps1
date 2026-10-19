<#
  Chạy OMP Board như một tiến trình riêng của Windows, không thuộc terminal/herdr/omp nào.
  Lý do: chạy bằng service của omp thì khi herdr hoặc các session omp bị đóng (SIGHUP), board chết theo.
  Ở đây board được tạo qua WMI (Win32_Process.Create) nên không nằm trong cây tiến trình hay job của ai.

  Cách dùng (từ thư mục repo, sau `npm run build`):
    powershell -ExecutionPolicy Bypass -File scripts\board-start.ps1            # bật (bỏ qua nếu đang chạy)
    powershell -ExecutionPolicy Bypass -File scripts\board-start.ps1 -Restart   # tắt rồi bật lại (sau khi build bản mới)
    powershell -ExecutionPolicy Bypass -File scripts\board-start.ps1 -Stop      # tắt
  Log: %LOCALAPPDATA%\omp-control-room\board.log (có in token, giữ trên máy này).
#>
param(
  [int]$Port = 3197,
  [switch]$Restart,
  [switch]$Stop
)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $env:LOCALAPPDATA 'omp-control-room'
$log = Join-Path $logDir 'board.log'

function ListenerPid {
  $conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { return [int]$conn.OwningProcess }
  return $null
}

function StopBoard {
  $owner = ListenerPid
  if (-not $owner) { Write-Host "Không có board nào ở cổng $Port."; return }
  # Only stop a node process running this repo's CLI: the port may belong to something else.
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $owner"
  if ($proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'dist[\\/]cli\.js') {
    throw "Cổng $Port đang thuộc tiến trình khác ($($proc.Name), pid $owner); không tắt."
  }
  Stop-Process -Id $owner -Force
  for ($i = 0; $i -lt 20 -and (ListenerPid); $i++) { Start-Sleep -Milliseconds 250 }
  Write-Host "Đã tắt board (pid $owner)."
}

if ($Stop) { StopBoard; exit 0 }
if ($Restart) { StopBoard }
elseif (ListenerPid) { Write-Host "Board đã chạy ở cổng $Port (pid $(ListenerPid))."; exit 0 }

if (-not (Test-Path (Join-Path $repo 'dist\cli.js'))) { throw "Chưa có dist\cli.js trong $repo. Chạy npm run build trước." }
$node = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Add-Content -Path $log -Value "`n==== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') bật board cổng $Port ===="

$command = "cmd.exe /d /c `"`"$node`" dist\cli.js --port $Port >> `"$log`" 2>&1`""
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = $command
  CurrentDirectory = $repo
  ProcessStartupInformation = $startup
}
if ($result.ReturnValue -ne 0) { throw "Windows không tạo được tiến trình (mã $($result.ReturnValue))." }

for ($i = 0; $i -lt 120 -and -not (ListenerPid); $i++) { Start-Sleep -Milliseconds 500 }
if (-not (ListenerPid)) { throw "Board chưa nghe cổng $Port sau 60 giây. Xem log: $log" }
Write-Host "Board đang chạy ở http://127.0.0.1:$Port (pid $(ListenerPid)). Log: $log" -ForegroundColor Green
