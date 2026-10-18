# Push local master to all three remotes with one command.
# Gitee / GitHub also call it master; AtomGit's default branch is main, mapped here.
# Usage: powershell -File scripts/push-all.ps1
$targets = @(
  @{ Remote = 'origin';  To = 'master' },
  @{ Remote = 'github';  To = 'master' },
  @{ Remote = 'atomgit'; To = 'main'   }
)

$failed = @()
foreach ($t in $targets) {
  Write-Host "==> $($t.Remote): master -> $($t.To)" -ForegroundColor Cyan
  git push $t.Remote "master:$($t.To)"
  if ($LASTEXITCODE -ne 0) { $failed += $t.Remote }
}
if ($failed.Count -gt 0) {
  Write-Host "FAILED: $($failed -join ', ')" -ForegroundColor Red
  exit 1
}

Write-Host "==> verify HEAD" -ForegroundColor Cyan
$local = (git rev-parse --short HEAD)
foreach ($t in $targets) {
  $out = git ls-remote --heads $t.Remote "refs/heads/$($t.To)"
  $sha = if ($out) { ($out -split '\s+')[0].Substring(0, 7) } else { '(branch missing)' }
  "{0,-8} {1,-7} {2}" -f $t.Remote, $t.To, $sha
}
"local    master  $local"
