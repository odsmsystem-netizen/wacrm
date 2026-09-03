# ===========================================================================
#  Allow inbound HTTPS on this host, for the Easypanel/Traefik container.
#
#  RUN AS ADMINISTRATOR.
#
#  WHY THIS EXISTS
#
#  Publishing 443 on the perimeter firewall is not enough when Easypanel
#  runs on Windows. Docker Desktop binds the port but does not create a
#  Windows Firewall rule for it, and Windows drops the inbound SYN with no
#  message anywhere. The result reads like a network fault rather than a
#  host one: the perimeter firewall logs the session as ALLOWED, the packet
#  is translated, and then nothing happens. On a Palo Alto the give-away is
#  a session logged as application "incomplete" ending in "aged-out" with a
#  couple of hundred bytes -- the three-way handshake never finished.
#
#  Everything else can be verified from the host itself and will look
#  healthy, because a request to 127.0.0.1 or to the host's own LAN address
#  is loopback and never passes the inbound firewall. Only traffic from
#  another machine does.
#
#  Run this once per host. It is safe to re-run: the rule is replaced.
#
#  Usage:  powershell -ExecutionPolicy Bypass -File scripts\open-https-port.ps1
#          ...  -Port 8443          (if Traefik's HTTPS entrypoint moved)
#          ...  -IncludePublic      (see the note on profiles below)
# ===========================================================================
[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 443,

    # Off by default. The Public profile is where Windows puts networks it
    # does not recognise -- VPN adapters, tethered phones, guest Wi-Fi. On a
    # server that reaches the internet through a corporate firewall, opening
    # the port there widens the exposure beyond the path you actually
    # audited, so it has to be asked for on purpose.
    [switch]$IncludePublic
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "This script needs to run as Administrator." -Foreground Red
    Write-Host "Right-click PowerShell -> Run as administrator, then run it again."
    exit 1
}

$name = "CRM WACRM HTTPS (port $Port)"

# Domain and Private together, not one or the other. Windows reclassifies a
# network on its own -- the same cable lands in Domain when it can reach a
# domain controller and in Private when it cannot -- and a rule bound to
# only one of them stops applying on a day nobody touched anything.
$profiles = if ($IncludePublic) { 'Domain,Private,Public' } else { 'Domain,Private' }

Write-Host "`n[1] Network profiles on this host" -Foreground Cyan
Get-NetConnectionProfile | ForEach-Object {
    $covered = switch ($_.NetworkCategory) {
        'DomainAuthenticated' { 'covered' }
        'Private'             { 'covered' }
        'Public'              { if ($IncludePublic) { 'covered' } else { 'NOT covered (-IncludePublic)' } }
        default               { '' }
    }
    Write-Host ("    {0,-32} {1,-22} {2}" -f $_.InterfaceAlias, $_.NetworkCategory, $covered)
}

Write-Host "`n[2] Firewall rule" -Foreground Cyan

# Sweep by prefix, not by exact name. The first rule for this port was
# created by hand before this script existed and carries a different name;
# leaving it behind would mean two rules for one port, and the next person
# reading the firewall would have no way to tell which one is authoritative.
# The prefix also covers the case where -Port changed between runs.
Get-NetFirewallRule -DisplayName 'CRM WACRM HTTPS*' -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Host "    Removing previous rule: $($_.DisplayName)" -Foreground Yellow
        Remove-NetFirewallRule -Name $_.Name
    }

New-NetFirewallRule `
    -DisplayName $name `
    -Description "Inbound HTTPS to the Easypanel/Traefik container serving the CRM" `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile $profiles `
    -Enabled True | Out-Null

Get-NetFirewallRule -DisplayName $name |
    Select-Object DisplayName, Enabled, Direction, Action, Profile |
    Format-Table -AutoSize | Out-String -Width 140

# A rule that exists and does not apply is the failure mode this whole file
# is about, so it is worth one more check: group policy can disable local
# rules outright, and then nothing here has any effect.
$blocked = Get-NetFirewallProfile | Where-Object {
    $_.Name -in @('Domain', 'Private') -and $_.AllowInboundRules -eq $false
}
if ($blocked) {
    Write-Host "    WARNING: inbound local rules are DISABLED by policy on the" -Foreground Yellow
    Write-Host "    $($blocked.Name -join ', ') profile(s). This rule will not take effect." -Foreground Yellow
    Write-Host "    Ask whoever manages group policy to permit port $Port." -Foreground Yellow
}

Write-Host "`nVerify from ANOTHER machine (not this one -- loopback bypasses the" -Foreground Cyan
Write-Host "inbound firewall and will succeed even when the rule is missing):" -Foreground Cyan
$ip = (Get-NetIPAddress -AddressFamily IPv4 |
       Where-Object { $_.InterfaceAlias -like 'Ethernet*' -and $_.IPAddress -notlike '169.254*' } |
       Select-Object -First 1).IPAddress
if ($ip) { Write-Host "    Test-NetConnection $ip -Port $Port`n" -Foreground DarkGray }
