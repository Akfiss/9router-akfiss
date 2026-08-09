# 9router-akfiss — one-command control for the built 9Router server.
#
# Collapses the deploy runbook in docs/BANSOS_GATEWAY_SETUP.md into a single
# verb, so routine operation stops being a seven-block copy-paste:
#
#   9router-akfiss            start the already-built server (default verb)
#   9router-akfiss stop       stop it
#   9router-akfiss restart    stop + start
#   9router-akfiss status     task / port / tunnel / cloudflared health
#   9router-akfiss build      stop -> production build -> start
#   9router-akfiss deploy     git pull -> build -> start
#
# Install the global shim once, into your PowerShell profile:
#   function 9router-akfiss { & '<repo>\scripts\9router-akfiss.ps1' @args }
#
# Overridable via environment: NINEROUTER_TASK_NAME (default "9Router Server"),
# PORT (default 20127).

[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'restart', 'status', 'build', 'deploy')]
  [string]$Command = 'start'
)

$ErrorActionPreference = 'Stop'

# Derived from this script's own location rather than hardcoded, so the file
# is machine-independent and targets whichever checkout it was run from.
$RepoRoot = Split-Path -Parent $PSScriptRoot
$TaskName = if ($env:NINEROUTER_TASK_NAME) { $env:NINEROUTER_TASK_NAME } else { '9Router Server' }
$Port = if ($env:PORT) { [int]$env:PORT } else { 20127 }

function Get-ListenerPids {
  Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique
}

# Single source of truth for the public hostname is the app's own constants
# file — don't duplicate the domain here.
function Get-PublicHost {
  $constants = Join-Path $RepoRoot 'src\lib\bansos\constants.js'
  if (-not (Test-Path $constants)) { return $null }
  $match = [regex]::Match((Get-Content -Raw $constants), "BANSOS_HOST\s*=\s*['`"]([^'`"]+)['`"]")
  if ($match.Success) { return $match.Groups[1].Value }
  return $null
}

function Get-HttpCode {
  param([string]$Url)
  $code = & curl.exe -s -o NUL -m 10 -w '%{http_code}' $Url 2>$null
  if ([string]::IsNullOrWhiteSpace($code)) { return 'no-response' }
  return $code
}

function Stop-Server {
  Write-Host "Stopping $TaskName ..."
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch { }
  Start-Sleep -Seconds 2

  # The scheduled task launches npm, which launches node; stopping the task
  # does not always reap the grandchild still holding the port.
  foreach ($processId in Get-ListenerPids) {
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
      Write-Host "  killed PID $processId (was holding port $Port)"
    } catch { }
  }

  Start-Sleep -Seconds 1
  if (Get-ListenerPids) { throw "Port $Port is still held after stop." }
  Write-Host "  stopped."
}

function Start-Server {
  $buildId = Join-Path $RepoRoot '.next\BUILD_ID'
  if (-not (Test-Path $buildId)) {
    throw "No production build at $buildId. Run: 9router-akfiss build"
  }

  Write-Host "Starting $TaskName ..."
  Start-ScheduledTask -TaskName $TaskName

  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if (Get-ListenerPids) { break }
  }

  $listeners = Get-ListenerPids
  if (-not $listeners) { throw "Server did not begin listening on port $Port within 45s." }
  Write-Host "  listening on port $Port (PID $($listeners -join ', '))"
}

function Invoke-Build {
  # @vercel/nft statically folds os.homedir() and, when the rest of the path
  # expression is unresolvable, globs the ENTIRE home directory. On Windows
  # that walks into the legacy "Application Data" junction and aborts the
  # build with `EPERM: operation not permitted, scandir`. Pointing HOME at an
  # empty directory for the duration of the build sidesteps it.
  #
  # The override is restored afterwards on purpose: this script is normally
  # invoked with `&` from a profile shim, so it shares the caller's process.
  # A server later started from a session with a hijacked USERPROFILE would
  # look for its SQLite DB in the empty directory and come up blank.
  $emptyHome = Join-Path ([IO.Path]::GetTempPath()) '9router-empty-home'
  New-Item -ItemType Directory -Force -Path $emptyHome | Out-Null

  $savedUserProfile = $env:USERPROFILE
  $savedHome = $env:HOME

  Write-Host "Building (HOME pinned to $emptyHome) ..."
  try {
    $env:USERPROFILE = $emptyHome
    $env:HOME = $emptyHome

    Push-Location $RepoRoot
    try { & npm.cmd run build } finally { Pop-Location }

    if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }
  } finally {
    $env:USERPROFILE = $savedUserProfile
    if ($null -eq $savedHome) {
      Remove-Item Env:HOME -ErrorAction SilentlyContinue
    } else {
      $env:HOME = $savedHome
    }
  }
  Write-Host "  build ok."
}

function Show-Status {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  $taskState = if ($task) { $task.State } else { 'not registered' }
  $listeners = Get-ListenerPids
  $service = Get-Service cloudflared -ErrorAction SilentlyContinue
  $buildId = Join-Path $RepoRoot '.next\BUILD_ID'

  Write-Host "repo             : $RepoRoot"
  Write-Host "build            : $(if (Test-Path $buildId) { (Get-Content -Raw $buildId).Trim() } else { 'MISSING - run: 9router-akfiss build' })"
  Write-Host "scheduled task   : $TaskName -> $taskState"
  Write-Host "port $Port       : $(if ($listeners) { "listening (PID $($listeners -join ', '))" } else { 'NOT listening' })"
  Write-Host "cloudflared      : $(if ($service) { $service.Status } else { 'not installed' })"
  Write-Host "local /login     : $(Get-HttpCode "http://127.0.0.1:$Port/login")   (expect 200)"

  $publicHost = Get-PublicHost
  if ($publicHost) {
    # 401 is the healthy answer: the probe is unauthenticated, and only our
    # own gate can produce a 401 — Cloudflare's failure pages (502, and
    # 530/error 1033 for a down tunnel) never do.
    Write-Host "tunnel /v1/models: $(Get-HttpCode "https://$publicHost/v1/models")   (expect 401)"
    # The ingress `path` rule must keep the dashboard off the public host.
    Write-Host "tunnel /dashboard: $(Get-HttpCode "https://$publicHost/dashboard")   (expect 404)"
  }
}

switch ($Command) {
  'start' { Start-Server }
  'stop' { Stop-Server }
  'restart' { Stop-Server; Start-Server }
  'status' { Show-Status }
  'build' { Stop-Server; Invoke-Build; Start-Server; Show-Status }
  'deploy' {
    Push-Location $RepoRoot
    try { & git.exe pull origin main } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw "git pull failed (exit $LASTEXITCODE)" }
    Stop-Server; Invoke-Build; Start-Server; Show-Status
  }
}
