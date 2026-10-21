# deploy.ps1 - copy the KO Twitch proxy to a VPS and install it.
#
# Run from Windows PowerShell:
#   .\deploy.ps1 -Server 203.0.113.10 -User root -Key "$HOME\.ssh\id_ed25519"
#
# Without -Server it asks for the VPS host. The VPS must be in a region where
# Twitch does not fill SSAI ads (TTV LOL PRO uses Russia). A proxy on your own
# machine does not help: its egress is still your ad-eligible IP.
param(
  [string]$Server,
  [string]$User = "root",
  [string]$Key = "$HOME\.ssh\id_rsa",
  [int]$Port = 22
)

$ErrorActionPreference = "Stop"
if (-not $Server) { $Server = Read-Host "VPS IP/host" }
if (-not $Server) { throw "no server" }

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$remoteDir = "/tmp/twitch-proxy"

$sshArgs = @("-p", "$Port", "-o", "StrictHostKeyChecking=accept-new")
$scpArgs = @("-P", "$Port", "-o", "StrictHostKeyChecking=accept-new", "-r")
if ($Key -and (Test-Path $Key)) {
  $sshArgs += @("-i", $Key)
  $scpArgs += @("-i", $Key)
} else {
  Write-Host "No key at '$Key' - ssh/scp will ask for the password." -ForegroundColor Yellow
}

Write-Host "==> preparing $remoteDir on $User@$Server" -ForegroundColor Cyan
& ssh @sshArgs -t "$User@$Server" "rm -rf $remoteDir"
if ($LASTEXITCODE -ne 0) { throw "ssh failed" }

Write-Host "==> copying proxy files" -ForegroundColor Cyan
& scp @scpArgs "$dir" "${User}@${Server}:/tmp/"
if ($LASTEXITCODE -ne 0) { throw "scp failed" }

Write-Host "==> installing (sudo may ask for the VPS password)" -ForegroundColor Cyan
& ssh @sshArgs -t "$User@$Server" "sudo bash $remoteDir/install.sh"
if ($LASTEXITCODE -ne 0) { throw "install failed" }

Write-Host ""
Write-Host "Copy the Address/Auth printed above into the extension popup:" -ForegroundColor Green
Write-Host "  Proxy HD (sem ads) -> host:port, user, pass -> Salvar" -ForegroundColor Green
