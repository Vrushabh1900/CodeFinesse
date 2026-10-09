# Starts the T3 Forge demo dashboard on http://127.0.0.1:4317
# Reads JEV_API_KEY from E:\MLH26\.env (never printed). Without it, routing uses the labelled rules fallback.
# Stop it with Ctrl+C in this window.
$ErrorActionPreference = "Stop"
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
Set-Location "$PSScriptRoot\t3code-main\t3code-main"
$envFile = "$PSScriptRoot\.env"
if (Test-Path $envFile) { node "--env-file=$envFile" apps/server/src/forge/demo/main.ts }
else { Write-Host "No .env found: Jev disabled, using rules fallback."; node apps/server/src/forge/demo/main.ts }
