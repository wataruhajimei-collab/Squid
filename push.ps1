param(
    [string]$message = "Update Squid game files"
)

$git = "$env:LOCALAPPDATA\Programs\MinGit\cmd\git.exe"
if (-not (Test-Path $git)) {
    $git = "git"
}

$repoDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repoDir

& $git add -A
$status = & $git status --porcelain
if (-not $status) {
    Write-Host "No changes detected. Repository is already up to date."
    exit 0
}

& $git commit -m $message
Write-Host "Pushing to GitHub..."
& $git push origin main
Write-Host "Push complete! Cloudflare deployment triggered."
