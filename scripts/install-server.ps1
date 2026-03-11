$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpBridgeDir = Join-Path $env:USERPROFILE ".mcp-bridge"
$EnvFile = Join-Path $McpBridgeDir ".env"
$McpBridgeJson = Join-Path $McpBridgeDir "config.json"

if ($args.Count -eq 0) {
    Write-Host "Usage: install-server.ps1 <server-name> [--dry-run] [--remove]"
    Write-Host ""
    Write-Host "Available servers:"
    Get-ChildItem -Path (Join-Path $ScriptDir "servers") -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

$ServerName = $args[0]
$DryRun = $args -contains "--dry-run"
$Remove = $args -contains "--remove"

$ServerDir = Join-Path $ScriptDir "servers\$ServerName"
if (-not (Test-Path $ServerDir)) {
    Write-Host "Error: Server '$ServerName' not found."
    Get-ChildItem -Path (Join-Path $ScriptDir "servers") -Directory | ForEach-Object { Write-Host "  - $($_.Name)" }
    exit 1
}

$ServerTitle = ($ServerName -replace '-', ' ' -split ' ' | ForEach-Object { if ($_.Length -gt 0) { $_.Substring(0,1).ToUpper() + $_.Substring(1) } }) -join ' '
$ServerConfigFile = Join-Path $ServerDir "config.json"
$EnvVarsFile = Join-Path $ServerDir "env_vars"

function Require-Command {
    param([string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Missing required command: $Name"
    }
}

function Get-TokenUrl {
    switch ($ServerName) {
        "apify"       { "https://console.apify.com/settings/integrations" }
        "github"      { "https://github.com/settings/tokens" }
        "google-maps" { "https://console.cloud.google.com/apis/credentials" }
        "hetzner"     { "https://console.hetzner.cloud/" }
        "hostinger"   { "https://hpanel.hostinger.com/api" }
        "linear"      { "https://linear.app/settings/api" }
        "miro"        { "https://miro.com/app/settings/user-profile/apps" }
        "notion"      { "https://www.notion.so/my-integrations" }
        "stripe"      { "https://dashboard.stripe.com/apikeys" }
        "tavily"      { "https://app.tavily.com/home" }
        "todoist"     { "https://app.todoist.com/app/settings/integrations/developer" }
        "wise"        { "https://wise.com/settings/api-tokens" }
        default       { "" }
    }
}

function Check-Prerequisites {
    switch ($ServerName) {
        "github"  { Require-Command docker }
        "linear"  { Require-Command node; Require-Command npm }
        { $_ -in "wise","hetzner" } { Require-Command git; Require-Command node; Require-Command npm }
        default   { Require-Command node; Require-Command npx }
    }
}

function Install-Dependencies {
    switch ($ServerName) {
        "github" {
            Write-Host "Pulling GitHub MCP server Docker image..."
            docker pull ghcr.io/github/github-mcp-server | Out-Host
        }
        "linear" {
            Write-Host "Installing @anthropic-pb/linear-mcp-server globally..."
            npm install -g @anthropic-pb/linear-mcp-server | Out-Host
        }
        "wise" {
            $cloneDir = Join-Path $ServerDir "mcp-server"
            if (Test-Path (Join-Path $cloneDir ".git")) {
                Write-Host "Updating wise mcp-server..."
                git -C $cloneDir pull --ff-only | Out-Host
            } else {
                Write-Host "Cloning wise mcp-server..."
                git clone https://github.com/Szotasz/wise-mcp.git $cloneDir | Out-Host
            }
            Push-Location $cloneDir
            npm install | Out-Host; npm run build | Out-Host
            Pop-Location
        }
        "hetzner" {
            $cloneDir = Join-Path $ServerDir "mcp-server"
            if (Test-Path (Join-Path $cloneDir ".git")) {
                Write-Host "Updating hetzner mcp-server..."
                git -C $cloneDir pull --ff-only | Out-Host
            } else {
                Write-Host "Cloning hetzner mcp-server..."
                git clone https://github.com/dkruyt/mcp-hetzner.git $cloneDir | Out-Host
            }
            Push-Location $cloneDir
            npm install | Out-Host; npm run build | Out-Host
            Pop-Location
        }
    }
}

function Get-PathOverride {
    switch ($ServerName) {
        "linear" {
            $npmRoot = npm root -g
            $distPath = Join-Path $npmRoot "@anthropic-pb/linear-mcp-server\dist\index.js"
            $buildPath = Join-Path $npmRoot "@anthropic-pb/linear-mcp-server\build\index.js"
            if (Test-Path $distPath) { return $distPath }
            if (Test-Path $buildPath) { return $buildPath }
            return $distPath
        }
        "wise"    { return (Join-Path $ServerDir "mcp-server\dist\cli.js") }
        "hetzner" { return (Join-Path $ServerDir "mcp-server\dist\index.js") }
        default   { return "" }
    }
}

function Ensure-Property {
    param($Object, [string]$Name, $DefaultValue)
    if (-not ($Object.PSObject.Properties.Name -contains $Name)) {
        $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $DefaultValue
    }
    return $Object.$Name
}

# ========================================
# REMOVE MODE
# ========================================
if ($Remove) {
    Write-Host "========================================"
    Write-Host "Removing $ServerTitle MCP Server"
    Write-Host "========================================"

    if (-not (Test-Path $McpBridgeJson)) {
        Write-Host "❌ Config not found: $McpBridgeJson" -ForegroundColor Red
        exit 1
    }

    $cfg = Get-Content $McpBridgeJson -Raw | ConvertFrom-Json
    $servers = $cfg.servers
    if (-not ($servers.PSObject.Properties.Name -contains $ServerName)) {
        Write-Host "ℹ️  Server '$ServerName' not found in config. Nothing to remove." -ForegroundColor Yellow
        exit 0
    }

    # Backup
    $backupFile = "$McpBridgeJson.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"
    Copy-Item $McpBridgeJson $backupFile
    Write-Host "Backup: $backupFile"

    # Remove server entry
    $servers.PSObject.Properties.Remove($ServerName)
    $cfg | ConvertTo-Json -Depth 10 | Set-Content $McpBridgeJson -Encoding UTF8
    Write-Host "✅ Removed $ServerName from config" -ForegroundColor Green
    Write-Host "ℹ️  Server recipe kept in servers\$ServerName\ (reinstall anytime)" -ForegroundColor Cyan

    # Remove env var from .env
    $envVarsFile = Join-Path $ServerDir "env_vars"
    if ((Test-Path $envVarsFile) -and (Test-Path $EnvFile)) {
        $envVarName = (Get-Content $envVarsFile -TotalCount 1).Trim()
        $envContent = Get-Content $EnvFile
        $filtered = $envContent | Where-Object { $_ -notmatch "^$envVarName=" }
        if ($filtered.Count -lt $envContent.Count) {
            $filtered | Set-Content $EnvFile -Encoding UTF8
            Write-Host "🔑 Removed $envVarName from $EnvFile" -ForegroundColor Green
        }
    }

    Write-Host "✅ $ServerTitle removed. Restart mcp-bridge to apply." -ForegroundColor Green
    exit 0
}

# ========================================
# INSTALL MODE
# ========================================
Write-Host "========================================"
Write-Host "Installing $ServerTitle MCP Server"
Write-Host "========================================"

if ($DryRun) {
    Write-Host "[DRY RUN] Server: $ServerName"
    if (Test-Path $EnvVarsFile) { Write-Host "[DRY RUN] Env var: $(Get-Content $EnvVarsFile -TotalCount 1)" }
    Write-Host "[DRY RUN] Config:"; Get-Content $ServerConfigFile
    exit 0
}

if (-not (Test-Path $EnvVarsFile)) { throw "Missing env_vars file in $ServerDir" }

$EnvVarName = (Get-Content $EnvVarsFile -TotalCount 1).Trim()
if ([string]::IsNullOrWhiteSpace($EnvVarName)) { throw "env_vars file does not contain a variable name" }

# 1. Prerequisites
Check-Prerequisites

# 2. Dependencies
Install-Dependencies

# 3. Get API token
$tokenUrl = Get-TokenUrl
if ($tokenUrl) { Write-Host "Get your API token here: $tokenUrl" }

$Token = ""
while ([string]::IsNullOrWhiteSpace($Token)) {
    $Token = Read-Host "Enter your $ServerTitle API token"
    if ([string]::IsNullOrWhiteSpace($Token)) { Write-Host "Token cannot be empty." }
}

# 4. Write to .env
New-Item -ItemType Directory -Force -Path $McpBridgeDir | Out-Null
if (-not (Test-Path $EnvFile)) { New-Item -ItemType File -Force -Path $EnvFile | Out-Null }

$envExists = Select-String -Path $EnvFile -Pattern "^$([regex]::Escape($EnvVarName))=" -Quiet
if ($envExists) {
    $overwrite = Read-Host "$EnvVarName already exists. Overwrite with new token? [y/N]"
    if ($overwrite -match "^[Yy]$") {
        $content = Get-Content $EnvFile | Where-Object { $_ -notmatch "^$([regex]::Escape($EnvVarName))=" }
        Set-Content -Path $EnvFile -Value $content -Encoding UTF8
        Add-Content -Path $EnvFile -Value "$EnvVarName=$Token"
        Write-Host "Updated $EnvVarName in $EnvFile"
    } else {
        Write-Host "Keeping existing value."
    }
} else {
    Add-Content -Path $EnvFile -Value "$EnvVarName=$Token"
    Write-Host "Saved $EnvVarName to $EnvFile"
}

# 5. Backup and merge config.json
if (-not (Test-Path $McpBridgeJson)) { Set-Content -Path $McpBridgeJson -Value "{}" -Encoding UTF8 }

$timestamp = Get-Date -Format "yyyyMMddHHmmss"
Copy-Item -Path $McpBridgeJson -Destination "$McpBridgeJson.bak-$timestamp" -Force
Write-Host "Backup: $McpBridgeJson.bak-$timestamp"

$cfgRaw = Get-Content -Path $McpBridgeJson -Raw
if ([string]::IsNullOrWhiteSpace($cfgRaw)) { $cfgRaw = "{}" }
$cfg = $cfgRaw | ConvertFrom-Json
$serverConfig = Get-Content -Path $ServerConfigFile -Raw | ConvertFrom-Json

$pathOverride = Get-PathOverride
if ($pathOverride -and $serverConfig.args -and $serverConfig.args.Count -gt 0) {
    for ($i = 0; $i -lt $serverConfig.args.Count; $i++) {
        if ($serverConfig.args[$i] -is [string] -and $serverConfig.args[$i].StartsWith("path/to/")) {
            $serverConfig.args[$i] = $pathOverride
        }
    }
}

if (-not ($cfg.PSObject.Properties.Name -contains "toolPrefix")) { $cfg | Add-Member -NotePropertyName "toolPrefix" -NotePropertyValue $true }
if (-not ($cfg.PSObject.Properties.Name -contains "reconnectIntervalMs")) { $cfg | Add-Member -NotePropertyName "reconnectIntervalMs" -NotePropertyValue 30000 }
if (-not ($cfg.PSObject.Properties.Name -contains "connectionTimeoutMs")) { $cfg | Add-Member -NotePropertyName "connectionTimeoutMs" -NotePropertyValue 10000 }
if (-not ($cfg.PSObject.Properties.Name -contains "requestTimeoutMs")) { $cfg | Add-Member -NotePropertyName "requestTimeoutMs" -NotePropertyValue 60000 }
$servers = Ensure-Property -Object $cfg -Name "servers" -DefaultValue ([PSCustomObject]@{})

if ($servers.PSObject.Properties.Name -contains $ServerName) {
    $servers.PSObject.Properties.Remove($ServerName)
}
$servers | Add-Member -NotePropertyName $ServerName -NotePropertyValue $serverConfig

$cfg | ConvertTo-Json -Depth 30 | Set-Content -Path $McpBridgeJson -Encoding UTF8
Write-Host "Configuration merged for: $ServerName"

Write-Host ""
Write-Host "$ServerTitle MCP Server installed."
Write-Host "Restart mcp-bridge to pick up the new server configuration."
