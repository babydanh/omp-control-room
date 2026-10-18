<#
  Mở OMP Board (đang chạy trên máy này) cho các thiết bị trong mạng Tailscale của bạn.
  Board vẫn chỉ nghe 127.0.0.1; `tailscale serve` nhận HTTPS trong tailnet rồi chuyển về cổng đó,
  nên không lộ ra internet và không cần mở firewall.

  Cách dùng:
    powershell -ExecutionPolicy Bypass -File scripts\board-tailscale.ps1 -Port 3197 -Token <token trong link board>
    powershell -ExecutionPolicy Bypass -File scripts\board-tailscale.ps1 -Off      # tắt chia sẻ
#>
param(
  [int]$Port = 3197,
  [string]$Token = '',
  [switch]$Off
)
$ErrorActionPreference = 'Stop'

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "LỖI: $text" -ForegroundColor Red; exit 1 }

# Tailscale installs here; PATH is not refreshed in an already open shell.
$ts = (Get-Command tailscale -ErrorAction SilentlyContinue).Source
if (-not $ts) { $ts = 'C:\Program Files\Tailscale\tailscale.exe' }

if (-not (Test-Path $ts)) {
  Step 'Bước 1/4: cài Tailscale (Windows sẽ hỏi quyền quản trị, bấm Yes)'
  winget install --id Tailscale.Tailscale -e --accept-package-agreements --accept-source-agreements
  if (-not (Test-Path $ts)) { Fail 'Chưa thấy tailscale.exe sau khi cài. Cài tay ở https://tailscale.com/download/windows rồi chạy lại script.' }
} else {
  Step 'Bước 1/4: Tailscale đã có sẵn'
}

if ($Off) {
  # `off` must repeat every flag used to turn the mapping on (Tailscale CLI docs); the target may be omitted.
  # Removes only this HTTPS:443 mapping; `serve reset` would wipe every Serve config.
  & $ts serve --bg --https=443 off
  if ($LASTEXITCODE -ne 0) { Fail 'Tắt chưa được (xem dòng lỗi phía trên).' }
  & $ts serve status
  Write-Host 'Đã tắt chia sẻ board qua Tailscale.' -ForegroundColor Green
  exit 0
}

Step 'Bước 2/4: đăng nhập Tailscale'
$status = & $ts status --json 2>$null | ConvertFrom-Json
if (-not $status -or $status.BackendState -ne 'Running') {
  Write-Host 'Trình duyệt sẽ mở trang đăng nhập. Đăng nhập xong quay lại cửa sổ này.'
  & $ts up
  $status = & $ts status --json | ConvertFrom-Json
  if ($status.BackendState -ne 'Running') { Fail 'Tailscale chưa đăng nhập xong.' }
}
$dns = $status.Self.DNSName.TrimEnd('.')
Write-Host "Máy này trong tailnet: $dns"

Step "Bước 3/4: kiểm board đang chạy ở 127.0.0.1:$Port"
$open = Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue
if (-not $open) { Fail "Không có gì nghe ở cổng $Port. Mở board trước (node dist/cli.js --port $Port) rồi chạy lại." }

Step 'Bước 4/4: chia sẻ board trong tailnet (HTTPS)'
Write-Host 'Lần đầu Tailscale có thể in một link bật HTTPS/MagicDNS cho tailnet: mở link đó, bấm Enable, rồi chạy lại script.'
& $ts serve --bg --https=443 "http://127.0.0.1:$Port"
if ($LASTEXITCODE -ne 0) { Fail 'tailscale serve chưa chạy được (xem dòng lỗi phía trên).' }
& $ts serve status

$url = "https://$dns/"
if ($Token) { $url = "${url}?token=$Token" }
Write-Host "`nXONG. Trên điện thoại/máy khác: cài app Tailscale, đăng nhập CÙNG tài khoản, rồi mở:" -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Yellow
if (-not $Token) { Write-Host '  (thêm ?token=... lấy từ link board in ra khi khởi động; thiếu token thì chỉ xem, không ra lệnh được)' }
Write-Host 'Token đổi mỗi lần board khởi động lại. Tắt chia sẻ: chạy script với -Off.'
