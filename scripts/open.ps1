# Shortcut trên Desktop gọi script này: bật app nếu chưa chạy rồi mở trình duyệt.
. (Join-Path $PSScriptRoot 'common.ps1')

if (-not (Test-AppRunning)) {
    Start-App
    [void](Wait-App)
}
Start-Process (Get-AppUrl)
