# Squeezr installer for Windows
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "Installing Squeezr from $ScriptDir..."
pip install -r "$ScriptDir\requirements.txt"

# Set ANTHROPIC_BASE_URL as persistent user env var
$existing = [System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", "User")
if (-not $existing) {
    [System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://localhost:8080", "User")
    Write-Host "Set ANTHROPIC_BASE_URL=http://localhost:8080 (user environment)."
} else {
    Write-Host "ANTHROPIC_BASE_URL already set to: $existing"
}

# Auto-start via Windows Task Scheduler
$TaskName = "Squeezr"
$PythonExe = (Get-Command python).Source
$MainScript = Join-Path $ScriptDir "main.py"

$existing_task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing_task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action  = New-ScheduledTaskAction -Execute $PythonExe -Argument "`"$MainScript`"" -WorkingDirectory $ScriptDir
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null

# Start it now
Start-ScheduledTask -TaskName $TaskName

Write-Host "Auto-start configured via Task Scheduler."
Write-Host ""
Write-Host "Done. Squeezr is running."
Write-Host "Restart your terminal for env var to take effect."
