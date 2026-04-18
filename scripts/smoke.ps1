param(
  [Parameter(Mandatory = $false)]
  [string]$ApiBase = ""
)

$ErrorActionPreference = "Stop"

function Get-ConfiguredApiBase {
  if ($ApiBase) { return $ApiBase.Trim().TrimEnd("/") }
  $configPath = Join-Path $PSScriptRoot "..\\config.js"
  if (!(Test-Path $configPath)) { throw "Missing config.js at $configPath" }
  $content = Get-Content $configPath -Raw
  $m = [regex]::Match($content, 'window\.JD_API_BASE\s*=\s*"([^"]+)"')
  if (!$m.Success) { return "" }
  return $m.Groups[1].Value.Trim().TrimEnd("/")
}

function Show-Result([string]$name, $res) {
  $status = $res.StatusCode
  $origin = $res.Headers["access-control-allow-origin"]
  $ct = $res.Headers["content-type"]
  Write-Host ("[{0}] HTTP {1}  CORS={2}  CT={3}" -f $name, $status, ($origin -join ","), ($ct -join ",")))
  try {
    $json = $res.Content | ConvertFrom-Json -ErrorAction Stop
    $json | ConvertTo-Json -Depth 8
  } catch {
    $res.Content | Select-Object -First 1
  }
  Write-Host ""
}

function Invoke-Json([string]$method, [string]$url, $body = $null, $headers = $null) {
  $h = @{}
  if ($headers) { $headers.GetEnumerator() | ForEach-Object { $h[$_.Key] = $_.Value } }
  if ($body -ne $null) {
    return Invoke-WebRequest -Method $method -Uri $url -Headers $h -ContentType "application/json" -Body ($body | ConvertTo-Json -Depth 8)
  }
  return Invoke-WebRequest -Method $method -Uri $url -Headers $h
}

$base = Get-ConfiguredApiBase
if (!$base) {
  Write-Host "JD_API_BASE is empty in config.js. The site will call same-origin /api which won't work on GitHub Pages." -ForegroundColor Yellow
  exit 2
}

Write-Host ("Using JD_API_BASE = {0}" -f $base)
Write-Host ""

# 0) Ping the Edge Function
try {
  $res = Invoke-Json "GET" "$base/api"
  Show-Result "ping" $res
} catch {
  Write-Host "[ping] FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
}

# 1) Public config
try {
  $res = Invoke-Json "GET" "$base/api/v1/public-config"
  Show-Result "public-config" $res
} catch {
  Write-Host "[public-config] FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
}

# 2) Products list
try {
  $res = Invoke-Json "GET" "$base/api/v1/products?limit=3"
  Show-Result "products" $res
} catch {
  Write-Host "[products] FAILED: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host ""
}

# 3) 2FA setup route existence check (should be 401 without token, not 404)
try {
  $res = Invoke-WebRequest -Method "GET" -Uri "$base/api/v1/admin/auth/2fa/setup"
  Show-Result "2fa-setup(no-auth)" $res
} catch {
  $resp = $_.Exception.Response
  if ($resp) {
    $r = Invoke-WebRequest -Method "GET" -Uri "$base/api/v1/admin/auth/2fa/setup" -SkipHttpErrorCheck
    Show-Result "2fa-setup(no-auth)" $r
  } else {
    Write-Host "[2fa-setup(no-auth)] FAILED: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
  }
}

Write-Host "Expected results:" -ForegroundColor Cyan
Write-Host "- ping: ok=true"
Write-Host "- public-config/products: ok=true"
Write-Host "- 2fa-setup(no-auth): HTTP 401 (UNAUTHORIZED). If you see 404 Route not found => the deployed Edge Function is old/not deployed."

