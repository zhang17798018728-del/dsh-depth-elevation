# Batch-repair the stale profile junctions.
#
# ~550 junctions under ~/.dsh/profiles/node_modules point at the previous
# Electron install (E:\dsh\DSH Desktop\...), which no longer exists. Node's
# resolver walks into them, fails, and stops — so plugins mounted under a
# profile cannot resolve their @deepseek-ai/* peers.
#
# Doing this one link per pwsh process is far too slow (~400 spawns), so the
# whole sweep runs in a single PowerShell session.
#
#   pwsh -NoProfile -File tools/repair-links.ps1           # dry run
#   pwsh -NoProfile -File tools/repair-links.ps1 -Apply    # rewrite links

param([switch]$Apply)

$ErrorActionPreference = 'Continue'
$root = Join-Path $env:USERPROFILE '.dsh\profiles\node_modules'
$newRoot = 'C:\Users\zzc\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules'

if (-not (Test-Path -LiteralPath $root)) { Write-Output "no profile modules at $root"; exit 0 }
if (-not (Test-Path -LiteralPath $newRoot)) { Write-Output "new install not found: $newRoot"; exit 1 }

$links = Get-ChildItem -Path $root -Recurse -Force -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.LinkType -eq 'Junction' -or $_.LinkType -eq 'SymbolicLink' }

$unusable = @()
foreach ($l in $links) {
  if (-not (Test-Path -LiteralPath (Join-Path $l.FullName 'package.json'))) {
    $unusable += $l
  }
}

Write-Output "links scanned : $($links.Count)"
Write-Output "unusable      : $($unusable.Count)"

$repairable = @()
$absent = @()
foreach ($l in $unusable) {
  $rel = $l.FullName.Substring($root.Length + 1)
  $target = Join-Path $newRoot $rel
  if (Test-Path -LiteralPath (Join-Path $target 'package.json')) {
    $repairable += [pscustomobject]@{ Link = $l.FullName; Target = $target; Rel = $rel }
  } else {
    $absent += $rel
  }
}

Write-Output "repairable    : $($repairable.Count)"
Write-Output "absent        : $($absent.Count)"
foreach ($a in ($absent | Select-Object -First 6)) { Write-Output "  absent: $a" }

if (-not $Apply) {
  Write-Output ''
  Write-Output '(dry run - pass -Apply to rewrite the repairable links)'
  exit 0
}

$fixed = 0
$failed = @()
foreach ($r in $repairable) {
  try {
    if (Test-Path -LiteralPath $r.Link) {
      # cmd rmdir removes a junction without touching its target; the
      # Remove-Item fallback covers a junction left half-created.
      cmd /c rmdir "`"$($r.Link)`"" 2>$null | Out-Null
      if (Test-Path -LiteralPath $r.Link) {
        Remove-Item -LiteralPath $r.Link -Force -Recurse -ErrorAction SilentlyContinue
      }
    }
    New-Item -ItemType Junction -Path $r.Link -Target $r.Target -ErrorAction Stop | Out-Null
    $fixed++
  } catch {
    $failed += "$($r.Rel): $($_.Exception.Message)"
  }
}

Write-Output ''
Write-Output "repaired      : $fixed/$($repairable.Count)"
Write-Output "failed        : $($failed.Count)"
foreach ($f in ($failed | Select-Object -First 8)) { Write-Output "  $f" }
