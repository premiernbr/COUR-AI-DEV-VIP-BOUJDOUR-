param(
  [Parameter(Mandatory = $false)]
  [string] $RepoPath = "C:\Dev\DEV",

  [Parameter(Mandatory = $false)]
  [string] $DenySid = "S-1-5-21-3774707160-2781618109-64764117-3470833169",

  [Parameter(Mandatory = $false)]
  [switch] $Recurse = $true
)

$ErrorActionPreference = "Stop"

$gitDir = Join-Path $RepoPath ".git"
if (!(Test-Path -LiteralPath $gitDir)) {
  throw "Not a git repo: $RepoPath (missing .git)"
}

$sid = [System.Security.Principal.SecurityIdentifier]::new($DenySid)
$targets = @($gitDir)
if ($Recurse) {
  $targets += Get-ChildItem -LiteralPath $gitDir -Force -Recurse -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }
}

 $changed = 0
foreach ($target in $targets) {
  try {
    $acl = Get-Acl -LiteralPath $target
    $denyRules = $acl.Access | Where-Object {
      $id = $_.IdentityReference
      $idValue = if ($id -is [System.Security.Principal.SecurityIdentifier]) { $id.Value } else { [string]$id }
      $idValue -eq $DenySid -and $_.AccessControlType -eq "Deny"
    }
    if ($denyRules -and $denyRules.Count -gt 0) {
      $acl.PurgeAccessRules($sid)
      Set-Acl -LiteralPath $target -AclObject $acl
      $changed++
    }
  } catch {
    # ignore and continue
  }
}

if ($changed -eq 0) {
  Write-Output "NO_DENY_RULES_FOUND"
  exit 0
}

Write-Output "DENY_RULES_REMOVED ($changed)"
