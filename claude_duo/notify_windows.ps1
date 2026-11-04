param(
    [string]$Title = "Claude-Duo",
    [string]$Message = "Alert"
)

try {
    $AppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $Template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $Nodes = $Template.GetElementsByTagName('text')
    $Nodes[0].AppendChild($Template.CreateTextNode($Title)) | Out-Null
    $Nodes[1].AppendChild($Template.CreateTextNode($Message)) | Out-Null
    $Toast = [Windows.UI.Notifications.ToastNotification]::new($Template)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($Toast)
} catch {
    # Fallback to NotifyIcon balloon
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $b = New-Object System.Windows.Forms.NotifyIcon
        $b.Icon = [System.Drawing.SystemIcons]::Warning
        $b.BalloonTipTitle = $Title
        $b.BalloonTipText = $Message
        $b.Visible = $True
        $b.ShowBalloonTip(3000)
        Start-Sleep -Milliseconds 800
        $b.Dispose()
    } catch {}
}
