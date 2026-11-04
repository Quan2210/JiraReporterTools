# Cập nhật: dừng app, lấy code mới (nếu dùng git), cài thư viện mới, chạy lại.
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Host "=== Cập nhật Jira Report ===" -ForegroundColor White

if (-not (Test-Path $VenvPy)) {
    Write-Host "Chưa cài đặt. Hãy bấm đúp CAI-DAT.bat trước." -ForegroundColor Red
    exit 1
}

Write-Step "Dừng ứng dụng"
Stop-App

if ((Test-Path (Join-Path $Root '.git')) -and (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Step "Tải bản mới từ git"
    Push-Location $Root
    try { & git pull --ff-only } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "git pull không thành công, vẫn dùng code hiện có." }
} else {
    Write-Warn2 "Thư mục này không phải git repo: hãy tải ZIP bản mới và giải nén ĐÈ lên thư mục này (giữ nguyên .env), rồi chạy lại file này."
}

Write-Step "Cài thư viện"
& $VenvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Root 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Write-Host "Cài thư viện thất bại." -ForegroundColor Red; exit 1 }

Write-Step "Khởi động lại"
Start-App
if (Wait-App) {
    Write-Ok "Xong. Tải lại trang (Ctrl+F5) để thấy bản mới."
    Start-Process (Get-AppUrl)
} else {
    Write-Host "Ứng dụng chưa lên. Xem lỗi trong file logs\app.log" -ForegroundColor Red
    exit 1
}
