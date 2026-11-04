# Gỡ: dừng app, bỏ tự chạy và shortcut. Không xoá source.
. (Join-Path $PSScriptRoot 'common.ps1')

Write-Host "=== Gỡ cài đặt Jira Report ===" -ForegroundColor White

Write-Step "Dừng ứng dụng và bỏ tự chạy"
Stop-App
foreach ($p in (Get-StartupShortcut), (Get-DesktopShortcut)) {
    if (Test-Path $p) { Remove-Item -LiteralPath $p -Force }
}
Write-Ok "Đã xoá shortcut khởi động và shortcut Desktop."

if (Test-Path $EnvFile) {
    $answer = Read-Host "Xoá luôn file .env (chứa PAT của bạn)? Gõ Y để xoá, Enter để giữ"
    if ($answer.Trim().ToUpper() -eq 'Y') {
        Remove-Item -LiteralPath $EnvFile -Force
        Write-Ok "Đã xoá .env."
    }
}
$DataDir = Join-Path $Root 'data'
if (Test-Path $DataDir) {
    $answer = Read-Host "Xoá luôn thư mục data (lịch nhắc nhở và lịch sử gửi)? Gõ Y để xoá, Enter để giữ"
    if ($answer.Trim().ToUpper() -eq 'Y') {
        Remove-Item -LiteralPath $DataDir -Recurse -Force
        Write-Ok "Đã xoá data."
    }
}
Write-Host "`nXong. Muốn dọn sạch hoàn toàn thì xoá thư mục này." -ForegroundColor Green
