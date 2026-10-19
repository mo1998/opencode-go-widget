# Expose the widget running inside WSL2 to your LAN (e.g. an Android phone).
#
# Run in an ADMIN PowerShell on Windows:
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-portproxy.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\windows-portproxy.ps1 -Port 8787 -Remove
#
# WSL2 in NAT mode sits behind its own virtual switch, so the phone cannot reach
# the WSL IP directly. This forwards Windows <LAN-IP>:<Port> -> WSL:<Port> and
# opens the firewall. Re-run after a Windows reboot if your WSL IP changes.
#
# Tip: switch WSL to mirrored networking and you can skip this entirely.
# Add to %UserProfile%\.wslconfig, then `wsl --shutdown`:
#   [wsl2]
#   networkingMode=mirrored

param(
  [int]$Port = 8787,
  [switch]$Remove
)

$ErrorActionPreference = "Stop"

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = New-Object Security.Principal.WindowsPrincipal($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
  Write-Error "Run this in an elevated (Administrator) PowerShell."
}

$ruleName = "OpenCode Go Widget ($Port)"

if ($Remove) {
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Write-Host "Removed port proxy and firewall rule for port $Port." -ForegroundColor Yellow
  exit 0
}

# Discover the current WSL IPv4 address.
$wslIp = (wsl hostname -I).Trim().Split(" ")[0]
if (-not $wslIp) { Write-Error "Could not determine the WSL IP. Is WSL running?" }

Write-Host "WSL IP: $wslIp  ->  port $Port" -ForegroundColor Cyan

netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov4 listenport=$Port listenaddress=0.0.0.0 connectport=$Port connectaddress=$wslIp | Out-Null

if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
    -Protocol TCP -LocalPort $Port -Profile Private | Out-Null
}

$lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.)' } |
  Sort-Object -Property InterfaceMetric |
  Select-Object -First 1 -ExpandProperty IPAddress)

Write-Host ""
Write-Host "Done. Open this on your phone (same Wi-Fi):" -ForegroundColor Green
Write-Host "  http://${lanIp}:$Port/" -ForegroundColor Green
Write-Host ""
Write-Host "Verify the forward:  netsh interface portproxy show v4tov4"
