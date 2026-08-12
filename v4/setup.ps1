#Requires -Version 5.1
# Productive v4 — interactive setup script for Windows
# Run: .\setup.ps1
[CmdletBinding()] param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info    ($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }
function Write-Success ($msg) { Write-Host "OK $msg" -ForegroundColor Green }
function Write-Fatal   ($msg) { Write-Host "!! $msg" -ForegroundColor Red; exit 1 }

$ScriptDir   = Split-Path -Parent $MyInvocation.MyCommand.Path
$EnvFile     = Join-Path $ScriptDir '.env'
$ExampleFile = Join-Path $ScriptDir '.env.example'

# ── Prerequisites ──────────────────────────────────────────────────────────────
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fatal "Docker not found. Install Docker Desktop from https://docs.docker.com/get-docker/"
}
$null = docker compose version 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fatal "Docker Compose v2 not found. Update Docker Desktop to the latest version."
}

Write-Host ""
Write-Host "Productive v4 -- Setup" -ForegroundColor White
Write-Host "===========================================" -ForegroundColor DarkGray
Write-Host ""

# ── .env file ─────────────────────────────────────────────────────────────────
if (-not (Test-Path $EnvFile)) {
    Copy-Item $ExampleFile $EnvFile
    Write-Info "Created .env from .env.example"
} else {
    Write-Info ".env already exists -- updating values only"
}

# ── Helpers ───────────────────────────────────────────────────────────────────
function Get-EnvValue ([string]$Key) {
    $line = Get-Content $EnvFile | Where-Object { $_ -match "^${Key}=(.*)$" } | Select-Object -First 1
    if ($line -match "^${Key}=(.*)$") { return $Matches[1] }
    return ''
}

function Set-EnvValue ([string]$Key, [string]$Value) {
    $lines = Get-Content $EnvFile
    $found = $false
    $updated = $lines | ForEach-Object {
        if ($_ -match "^${Key}=") { $found = $true; "${Key}=${Value}" } else { $_ }
    }
    if (-not $found) { $updated = @($updated) + "${Key}=${Value}" }
    $updated | Set-Content $EnvFile
}

function New-HexKey32 {
    $b = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    return ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

function New-FernetKey {
    $b = [byte[]]::new(32)
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    # URL-safe base64: replace + with - and / with _  (keep = padding)
    return [Convert]::ToBase64String($b).Replace('+', '-').Replace('/', '_')
}

# ── Generate secrets ───────────────────────────────────────────────────────────
Write-Host "Generating secrets..." -ForegroundColor White

if ([string]::IsNullOrEmpty((Get-EnvValue 'JWT_SECRET_KEY'))) {
    Set-EnvValue 'JWT_SECRET_KEY' (New-HexKey32)
    Write-Success "JWT_SECRET_KEY generated"
} else {
    Write-Success "JWT_SECRET_KEY already set -- skipped"
}

if ([string]::IsNullOrEmpty((Get-EnvValue 'FERNET_KEY'))) {
    Set-EnvValue 'FERNET_KEY' (New-FernetKey)
    Write-Success "FERNET_KEY generated"
} else {
    Write-Success "FERNET_KEY already set -- skipped"
}

Write-Host ""

# ── Interactive prompt helper ──────────────────────────────────────────────────
function Read-EnvValue ([string]$Label, [string]$Key, [bool]$Required = $true) {
    $current = Get-EnvValue $Key
    if (-not [string]::IsNullOrEmpty($current)) {
        Write-Host "  ${Key} " -NoNewline
        Write-Host "[set -- press Enter to keep, or type a new value]" -ForegroundColor Yellow
        $val = Read-Host "  ->"
        if ([string]::IsNullOrEmpty($val)) { $val = $current }
    } else {
        if ($Required) {
            Write-Host "  ${Label} " -NoNewline; Write-Host "(required)" -ForegroundColor Red
        } else {
            Write-Host "  ${Label} " -NoNewline; Write-Host "(optional -- press Enter to skip)" -ForegroundColor Yellow
        }
        $val = Read-Host "  ->"
        if ($Required -and [string]::IsNullOrEmpty($val)) {
            Write-Fatal "${Key} is required. Re-run setup.ps1 to try again."
        }
    }
    if (-not [string]::IsNullOrEmpty($val)) { Set-EnvValue $Key $val }
}

# ── Domain ─────────────────────────────────────────────────────────────────────
Write-Host "Your domain" -ForegroundColor White
Write-Host "  Where Productive will be accessible."
Write-Host "  Local only:  http://localhost:3005"
Write-Host "  Production:  https://your-domain.com"
Read-EnvValue "Domain / origin URL" "APP_ORIGIN_V4" $true

$origin      = Get-EnvValue 'APP_ORIGIN_V4'
$redirectUri = "${origin}/api/v1/auth/callback"

# ── Google OAuth ───────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Google OAuth" -ForegroundColor White
Write-Host "  1. Go to console.cloud.google.com -> APIs & Services -> Credentials"
Write-Host "  2. Create credentials -> OAuth 2.0 Client ID -> Web application"
Write-Host "  3. Add Authorised redirect URI: " -NoNewline
Write-Host $redirectUri -ForegroundColor Yellow
Write-Host ""
Read-EnvValue "Google Client ID"     "GOOGLE_CLIENT_ID"     $true
Read-EnvValue "Google Client Secret"  "GOOGLE_CLIENT_SECRET"  $true
Set-EnvValue 'GOOGLE_REDIRECT_URI' $redirectUri
Write-Success "GOOGLE_REDIRECT_URI set to ${redirectUri}"

# ── GitHub OAuth (optional) ────────────────────────────────────────────────────
Write-Host ""
Write-Host "GitHub OAuth -- optional second login method" -ForegroundColor White
Write-Host "  github.com -> Settings -> Developer settings -> OAuth Apps -> New OAuth App"
Write-Host "  Callback URL: " -NoNewline; Write-Host $redirectUri -ForegroundColor Yellow
Write-Host ""
Read-EnvValue "GitHub Client ID"     "GITHUB_CLIENT_ID"     $false
Read-EnvValue "GitHub Client Secret"  "GITHUB_CLIENT_SECRET"  $false

# ── Access control ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Access control" -ForegroundColor White
Write-Host "  Comma-separated list of emails that can sign in."
Write-Host "  Leave empty to allow any authenticated Google/GitHub account."
Read-EnvValue "Allowed emails" "ALLOWED_EMAILS" $false

# ── Cloudflare Tunnel ──────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Cloudflare Tunnel -- optional, needed for HTTPS / public domain" -ForegroundColor White
Write-Host "  Zero Trust -> Networks -> Tunnels -> Create tunnel -> name: productive-v4"
Write-Host "  Public hostname: ${origin} -> Service: http://frontend-v4:3005" -ForegroundColor Yellow
Read-EnvValue "Cloudflare Tunnel token" "CLOUDFLARE_TUNNEL_TOKEN_V4" $false

# ── Done ───────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "===========================================" -ForegroundColor DarkGray
Write-Success ".env is configured"
Write-Host ""

$launch = Read-Host "Start containers now? [Y/n]"
if ($launch -match '^[Nn]$') {
    Write-Host ""
    Write-Info "Run when ready:"
    Write-Host "    docker compose up -d"
} else {
    Write-Host ""
    Write-Info "Starting containers -- first build compiles Rust and may take a few minutes..."
    & docker compose -f (Join-Path $ScriptDir 'docker-compose.yml') up -d --build
    Write-Host ""
    Write-Success "Productive is running at ${origin}"
    Write-Host ""
    Write-Host "  Sign in at: ${origin}"
    Write-Host "  To stop:    docker compose down"
    Write-Host "  Logs:       docker compose logs -f"
}
