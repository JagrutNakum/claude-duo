$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "Claude-Duo.lnk"
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$ExePath = Join-Path $PSScriptRoot "dist\Claude-Duo-win32-x64\Claude-Duo.exe"
$IconPath = Join-Path $PSScriptRoot "assets\icon.ico"
$Shortcut.TargetPath = $ExePath
$Shortcut.WorkingDirectory = Join-Path $PSScriptRoot "dist\Claude-Duo-win32-x64"
$Shortcut.Description = "Claude-Duo • Shared Pro Limit Monitor"
if (Test-Path $IconPath) {
    $Shortcut.IconLocation = $IconPath
}
$Shortcut.Save()
Write-Host "Created Desktop Shortcut with Icon: $ShortcutPath" -ForegroundColor Green
