# Hàm dùng chung cho các script cài đặt / cập nhật / gỡ. Không chạy trực tiếp.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = Split-Path -Parent $PSScriptRoot
$Venv = Join-Path $Root '.venv'
$VenvPy = Join-Path $Venv 'Scripts\python.exe'
$VenvPyW = Join-Path $Venv 'Scripts\pythonw.exe'
$EnvFile = Join-Path $Root '.env'
$ShortcutName = 'Jira Report.lnk'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text) { Write-Host "    $text" -ForegroundColor Yellow }

function Get-EnvValue([string]$Name) {
    if (-not (Test-Path $EnvFile)) { return '' }
    foreach ($line in Get-Content -LiteralPath $EnvFile -Encoding UTF8) {
        if ($line -match "^\s*$Name\s*=\s*(.*)$") { return $Matches[1].Trim() }
    }
    return ''
}

function Get-AppPort {
    $p = Get-EnvValue 'PORT'
    if ($p -match '^\d+$') { return [int]$p }
    return 8000
}

function Get-AppUrl { return "http://127.0.0.1:$(Get-AppPort)" }

function Get-ListenerPid {
    $conn = Get-NetTCPConnection -LocalPort (Get-AppPort) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return $conn.OwningProcess }
    return $null
}

function Test-AppRunning { return [bool](Get-ListenerPid) }

function Stop-App {
    $listener = Get-ListenerPid
    if (-not $listener) { return }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $listener" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -like '*run.py*') {
        # /T: kết thúc cả cây tiến trình (pythonw trong venv có thể sinh tiến trình con)
        & taskkill.exe /PID $listener /T /F | Out-Null
        Start-Sleep -Seconds 1
    } else {
        Write-Warn2 "Cổng $(Get-AppPort) đang bị chương trình khác dùng (PID $listener). Đổi PORT trong .env hoặc tắt chương trình đó."
    }
}

function Start-App {
    if (Test-AppRunning) { return }
    Start-Process -FilePath $VenvPyW -ArgumentList 'run.py' -WorkingDirectory $Root -WindowStyle Hidden
}

function Wait-App([int]$TimeoutSeconds = 40) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-AppRunning) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$WorkDir, [string]$Description, [int]$Window = 1, [string]$Icon = '') {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    $lnk.Arguments = $Arguments
    $lnk.WorkingDirectory = $WorkDir
    $lnk.Description = $Description
    $lnk.WindowStyle = $Window
    if ($Icon -and (Test-Path -LiteralPath $Icon)) { $lnk.IconLocation = "$Icon,0" }
    $lnk.Save()
}

function Get-StartupShortcut { return Join-Path ([Environment]::GetFolderPath('Startup')) $ShortcutName }
function Get-DesktopShortcut { return Join-Path ([Environment]::GetFolderPath('Desktop')) $ShortcutName }
