param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string] $Command,

  [Parameter(Position = 1)]
  [string] $Arg1
)

$ErrorActionPreference = "Stop"

function Load-DotEnv {
  param([Parameter(Mandatory = $true)][string] $Path)

  if (!(Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (!$line) { return }
    if ($line.StartsWith("#")) { return }
    $idx = $line.IndexOf("=")
    if ($idx -lt 1) { return }
    $key = $line.Substring(0, $idx).Trim()
    $value = $line.Substring($idx + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }
    if ($key) {
      Set-Item -Path "Env:$key" -Value $value
    }
  }
}

function Require-Env {
  param([Parameter(Mandatory = $true)][string] $Name)
  $value = [string] (Get-Item -Path "Env:$Name" -ErrorAction SilentlyContinue).Value
  if (!$value) { throw "Missing required env var: $Name (set it in .env.supabase or in your environment)" }
  return $value
}

function Ensure-LoadedEnv {
  Load-DotEnv -Path (Join-Path $PSScriptRoot "..\\.env.supabase")
}

function Ensure-SupabaseAuth {
  # Supabase CLI requires an access token for Management API commands unless you are logged in.
  # We prefer env-based auth to keep VS Code tasks non-interactive.
  $token = (Get-Item -Path Env:SUPABASE_ACCESS_TOKEN -ErrorAction SilentlyContinue).Value
  if (!$token) {
    throw "SUPABASE_ACCESS_TOKEN is missing. Create .env.supabase from .env.supabase.example (or run: npx supabase login)."
  }
}

function Invoke-Supabase {
  # Do not name this parameter "Args" because `$args` is an automatic variable in PowerShell.
  param([Parameter(Mandatory = $true)][string[]] $SupabaseArgs)
  $supabaseCmd = Get-Command supabase -ErrorAction SilentlyContinue
  if ($supabaseCmd) {
    & "supabase" @SupabaseArgs
  } else {
    # Supabase docs recommend running via npx (or installing as a local dev dependency).
    # This avoids requiring a global/system install on Windows.
    if (!(Get-Command npx -ErrorAction SilentlyContinue)) {
      throw "Neither supabase nor npx is available. Install Node.js 20+ (includes npx) or add Supabase CLI to PATH."
    }
    # Avoid EACCES in locked-down environments by using a workspace-local npm cache.
    $cacheDir = Join-Path $PSScriptRoot "..\\.npm-cache"
    if (!(Test-Path -LiteralPath $cacheDir)) {
      New-Item -ItemType Directory -Path $cacheDir | Out-Null
    }
    $env:NPM_CONFIG_CACHE = (Resolve-Path -LiteralPath $cacheDir).Path
    & "npx" "--yes" "supabase" @SupabaseArgs
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Supabase CLI failed: supabase $($SupabaseArgs -join ' ')"
  }
}

Ensure-LoadedEnv

switch ($Command) {
  "projects:list" {
    Ensure-SupabaseAuth
    Invoke-Supabase -SupabaseArgs @("projects", "list", "--output", "json")
    break
  }

  "init" {
    # Creates supabase/config.toml and VS Code settings if desired.
    Invoke-Supabase -SupabaseArgs @("init", "--force")
    break
  }

  "link" {
    Ensure-SupabaseAuth
    $projectRef = if ($Arg1) { $Arg1 } else { Require-Env "SUPABASE_PROJECT_REF" }
    $dbPass = (Get-Item -Path Env:SUPABASE_DB_PASSWORD -ErrorAction SilentlyContinue).Value
    if ($dbPass) {
      Invoke-Supabase -SupabaseArgs @("link", "--project-ref", $projectRef, "--password", $dbPass, "--yes")
    } else {
      Invoke-Supabase -SupabaseArgs @("link", "--project-ref", $projectRef, "--yes")
    }
    break
  }

  "db:push" {
    # Requires link first (or pass --db-url directly).
    Invoke-Supabase -SupabaseArgs @("db", "push", "--yes")
    break
  }

  "db:tables" {
    Ensure-SupabaseAuth
    Invoke-Supabase -SupabaseArgs @("db", "query", "--linked", "-f", "supabase/sql/tables.sql", "-o", "json")
    break
  }

  "db:counts" {
    Ensure-SupabaseAuth
    Invoke-Supabase -SupabaseArgs @("db", "query", "--linked", "-f", "supabase/sql/counts.sql", "-o", "json")
    break
  }

  "db:diff" {
    $name = if ($Arg1) { $Arg1 } else { "diff" }
    Invoke-Supabase -SupabaseArgs @("db", "diff", "-f", $name)
    break
  }

  "types:gen" {
    $projectRef = if ($Arg1) { $Arg1 } else { Require-Env "SUPABASE_PROJECT_REF" }
    Invoke-Supabase -SupabaseArgs @("gen", "types", "typescript", "--project-id", $projectRef, "--schema", "public")
    break
  }

  "functions:list" {
    Ensure-SupabaseAuth
    Invoke-Supabase -SupabaseArgs @("functions", "list", "--output", "json")
    break
  }

  "functions:deploy" {
    Ensure-SupabaseAuth
    # Deploy all functions under supabase/functions
    Invoke-Supabase -SupabaseArgs @("functions", "deploy")
    break
  }

  "config:push" {
    Ensure-SupabaseAuth
    $projectRef = (Get-Item -Path Env:SUPABASE_PROJECT_REF -ErrorAction SilentlyContinue).Value
    if ($projectRef) {
      Invoke-Supabase -SupabaseArgs @("config", "push", "--project-ref", $projectRef)
    } else {
      Invoke-Supabase -SupabaseArgs @("config", "push")
    }
    break
  }

  default {
    throw "Unknown command: $Command`nCommands: projects:list, init, link, db:push, db:tables, db:counts, db:diff, types:gen, functions:list, functions:deploy, config:push"
  }
}
