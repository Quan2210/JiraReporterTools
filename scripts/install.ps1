# Cài đặt một lần: Python, thư viện, PAT, tự chạy khi đăng nhập Windows, shortcut Desktop.
. (Join-Path $PSScriptRoot 'common.ps1')

function Find-Python {
    $candidates = @(
        @{ Exe = 'py'; Args = @('-3') },
        @{ Exe = 'python'; Args = @() }
    )
    foreach ($c in $candidates) {
        try {
            $out = & $c.Exe @($c.Args) -c "import sys; print(sys.executable if sys.version_info >= (3,10) else '')" 2>$null
            if ($LASTEXITCODE -eq 0 -and $out -and (Test-Path ([string]$out).Trim())) { return ([string]$out).Trim() }
        } catch { }
    }
    $local = Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe" -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending | Select-Object -First 1
    if ($local) { return $local.FullName }
    return $null
}

function Update-SessionPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Write-Host "=== Cài đặt Jira Report ===" -ForegroundColor White

# 1. Python ------------------------------------------------------------------
Write-Step "Kiểm tra Python (cần bản 3.10 trở lên)"
$python = Find-Python
if (-not $python) {
    Write-Warn2 "Máy này chưa có Python (hoặc bản cũ hơn 3.10). Ứng dụng cần Python để chạy."
    Write-Host "    Mình có thể cài Python giúp bạn (bản chính thức, miễn phí, chỉ cài cho tài khoản của bạn, không cần quyền Admin)."
    $answer = Read-Host "Cài Python giúp bạn? Nhấn Enter để đồng ý, gõ N để tự cài"
    if ($answer.Trim().ToUpper() -eq 'N') {
        Write-Host "Hãy tải Python tại https://www.python.org/downloads/ , khi cài nhớ TICK 'Add python.exe to PATH', rồi bấm đúp CAI-DAT.bat lại." -ForegroundColor Yellow
        exit 1
    }

    # Cách 1: winget (có sẵn trên Windows 10/11 mới)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Warn2 "Đang cài Python bằng winget (mất vài phút, vui lòng đợi)..."
        & winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
        Update-SessionPath
        $python = Find-Python
    }

    # Cách 2: tải bộ cài chính thức từ python.org
    if (-not $python) {
        $pyVersion = '3.12.10'
        $exeName = if ([Environment]::Is64BitOperatingSystem) { "python-$pyVersion-amd64.exe" } else { "python-$pyVersion.exe" }
        $url = "https://www.python.org/ftp/python/$pyVersion/$exeName"
        $dest = Join-Path $env:TEMP $exeName
        try {
            Write-Warn2 "Đang tải Python từ python.org (khoảng 25 MB)..."
            Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
            $sig = Get-AuthenticodeSignature -FilePath $dest
            if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notlike '*Python Software Foundation*') {
                throw "Chữ ký số của bộ cài không hợp lệ, đã huỷ để đảm bảo an toàn."
            }
            Write-Warn2 "Đang cài Python (mất vài phút, vui lòng đợi)..."
            $proc = Start-Process -FilePath $dest -ArgumentList '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=0', 'Include_test=0' -Wait -PassThru
            if ($proc.ExitCode -ne 0) { throw "Bộ cài Python báo lỗi (mã $($proc.ExitCode))." }
            Update-SessionPath
            $python = Find-Python
        } catch {
            Write-Warn2 "Không cài được Python tự động: $($_.Exception.Message)"
        } finally {
            Remove-Item -LiteralPath $dest -Force -ErrorAction SilentlyContinue
        }
    }
}
if (-not $python) {
    Write-Host "Không cài được Python tự động." -ForegroundColor Red
    Write-Host "Hãy tải Python tại https://www.python.org/downloads/ , khi cài nhớ TICK 'Add python.exe to PATH', rồi bấm đúp CAI-DAT.bat lại."
    exit 1
}
Write-Ok "Python: $python"

# 2. Môi trường ảo + thư viện --------------------------------------------------
Write-Step "Cài thư viện (lần đầu mất 1-2 phút)"
$venvOk = $false
if (Test-Path $VenvPy) {
    # .venv copy từ máy khác sang sẽ trỏ tới Python không tồn tại -> phải tạo lại
    try { & $VenvPy -c "import sys" 2>$null; $venvOk = ($LASTEXITCODE -eq 0) } catch { $venvOk = $false }
}
if (-not $venvOk) {
    if (Test-Path $Venv) { Write-Warn2 "Môi trường .venv cũ không dùng được, đang tạo lại..."; Remove-Item -LiteralPath $Venv -Recurse -Force }
    & $python -m venv $Venv
    if ($LASTEXITCODE -ne 0) { Write-Host "Không tạo được môi trường .venv" -ForegroundColor Red; exit 1 }
}
& $VenvPy -m pip install --disable-pip-version-check -q -r (Join-Path $Root 'requirements.txt')
if ($LASTEXITCODE -ne 0) { Write-Host "Cài thư viện thất bại. Kiểm tra kết nối mạng rồi chạy lại." -ForegroundColor Red; exit 1 }
Write-Ok "Xong."

# 3. Cấu hình PAT ------------------------------------------------------------------
Write-Step "Cấu hình kết nối Jira"
$keep = $false
$currentUrl = Get-EnvValue 'JIRA_BASE_URL'
if (((Get-EnvValue 'JIRA_PAT') -ne '') -and $currentUrl) {
    $answer = Read-Host "Đã có cấu hình Jira ($currentUrl) và PAT. Nhấn Enter để giữ nguyên, hoặc gõ N để nhập lại"
    $keep = ($answer.Trim().ToUpper() -ne 'N')
}
if (-not $keep) {
    # Địa chỉ Jira do người dùng nhập, không có sẵn trong source (không lộ địa chỉ nội bộ của công ty khi chia sẻ code)
    $baseUrl = $null
    while (-not $baseUrl) {
        $prompt = if ($currentUrl) { "Địa chỉ Jira (Enter để dùng $currentUrl)" } else { "Nhập địa chỉ Jira (ví dụ https://jira.congty.com)" }
        $typed = (Read-Host $prompt).Trim()
        if (-not $typed) { $typed = $currentUrl }
        if ($typed -and ($typed -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://')) { $typed = "https://$typed" }
        if ($typed -match '^https?://[^/\s]+(/[^\s]*)?$') {
            $baseUrl = $typed.TrimEnd('/')
            if ($baseUrl -match '^http://') { Write-Warn2 "Địa chỉ dùng http (không mã hoá): PAT sẽ được gửi không mã hoá. Nên dùng https nếu Jira hỗ trợ." }
        } else {
            Write-Warn2 "Địa chỉ không hợp lệ. Ví dụ: https://jira.congty.com"
        }
    }

    Write-Host ""
    Write-Host "Cách lấy PAT: mở Jira -> bấm avatar -> Profile -> Personal Access Tokens -> Create token."
    Write-Host "Copy token, dán vào đây (khi dán sẽ không hiện ký tự, cứ dán rồi nhấn Enter)."
    $pat = $null
    for ($try = 1; $try -le 3; $try++) {
        $secure = Read-Host "Dán PAT" -AsSecureString
        $candidate = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)).Trim()
        if (-not $candidate) { Write-Warn2 "PAT đang trống."; continue }
        try {
            $me = Invoke-RestMethod -Uri "$baseUrl/rest/api/2/myself" -Headers @{ Authorization = "Bearer $candidate"; Accept = 'application/json' } -TimeoutSec 20
            Write-Ok "Kết nối thành công, xin chào $($me.displayName)."
            $pat = $candidate
            break
        } catch {
            $status = $null
            if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
            if ($status -eq 401) {
                Write-Warn2 "Jira từ chối PAT này (sai hoặc hết hạn). Thử lại ($try/3)."
            } else {
                Write-Warn2 "Chưa kiểm tra được kết nối tới Jira ($($_.Exception.Message))."
                Write-Warn2 "Nếu Jira cần VPN thì hãy bật VPN. Mình vẫn lưu PAT này, bạn có thể kiểm tra sau."
                $pat = $candidate
                break
            }
        }
    }
    if (-not $pat) { Write-Host "Chưa có PAT hợp lệ. Hãy chạy CAI-DAT.bat lại khi đã tạo được PAT." -ForegroundColor Red; exit 1 }

    $lines = @("JIRA_BASE_URL=$baseUrl", "JIRA_PAT=$pat")
    foreach ($name in 'MAX_ROWS', 'PAGE_SIZE', 'PORT', 'CA_BUNDLE') {
        $v = Get-EnvValue $name
        if ($v) { $lines += "$name=$v" }
    }
    [IO.File]::WriteAllText($EnvFile, ($lines -join "`r`n") + "`r`n", (New-Object Text.UTF8Encoding($false)))
    Write-Ok "Đã lưu cấu hình vào .env (chỉ nằm trên máy này)."
}

# 4. Tự chạy khi đăng nhập + shortcut Desktop ------------------------------------
Write-Step "Thiết lập tự chạy khi mở máy"
New-Shortcut -Path (Get-StartupShortcut) -Target $VenvPyW -Arguments 'run.py' -WorkDir $Root -Description 'Jira Report (chạy nền)' -Window 7
New-Shortcut -Path (Get-DesktopShortcut) -Target 'powershell.exe' `
    -Arguments "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'open.ps1')`"" `
    -WorkDir $Root -Description 'Mở Jira Report' -Window 7 -Icon (Join-Path $Root 'assets\icon.ico')
Write-Ok "Đã tạo shortcut 'Jira Report' ngoài Desktop."

# 5. Chạy ngay ----------------------------------------------------------------
Write-Step "Khởi động ứng dụng"
Stop-App
Start-App
if (Wait-App) {
    Write-Ok "Ứng dụng đã chạy tại $(Get-AppUrl)"
    Start-Process (Get-AppUrl)
} else {
    Write-Host "Ứng dụng chưa lên. Xem lỗi trong file logs\app.log" -ForegroundColor Red
    exit 1
}

Write-Host "`nHoàn tất! Từ giờ bấm shortcut 'Jira Report' ngoài Desktop để mở (app cũng tự chạy mỗi khi bạn đăng nhập Windows)." -ForegroundColor Green
