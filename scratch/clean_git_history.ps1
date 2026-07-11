# scratch/clean_git_history.ps1
# Script to safely purge 1.5GB Git history and re-initialize a clean, optimized repository.
# All local files (code, database, netlify configs) remain 100% intact on your machine.

Write-Output "=== Starting Git History Cleanup ==="

# 1. Store the remote URL
$remoteUrl = "https://github.com/armstrong876/MF-Reasearch.git"
Write-Output "Target Remote: $remoteUrl"

# 2. Delete the old .git directory to purge 1.5GB history
if (Test-Path ".git") {
    Write-Output "Removing old 1.5GB .git folder..."
    Remove-Item -Recurse -Force ".git"
}

# 3. Re-initialize fresh Git repository
Write-Output "Initializing fresh Git repository..."
git init

# 4. Add remote origin
git remote add origin $remoteUrl

# 5. Switch to main branch
git branch -M main

# 6. Add all files (excludes data/mf_research.db because of .gitignore)
Write-Output "Staging files (ignoring data/mf_research.db)..."
git add .

# 7. Initial commit
git commit -m "initial commit: clean codebase with automated release database"

Write-Output "=== Git History Cleaned Successfully ==="
Write-Output "To push to GitHub, run: git push -u origin main --force"
