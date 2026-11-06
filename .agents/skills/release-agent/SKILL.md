---
name: release-agent
description: Autonomous release agent for Claude-Duo. Handles pre-flight checks, package.json version bumping, git commits, git tagging, and pushing to trigger the GitHub Actions release workflow.
---

# Claude-Duo Release Agent

Autonomous agent runbook for executing releases of Claude-Duo to GitHub.

## Workflow

### 1. Pre-flight Verification
- Verify clean git status:
  ```powershell
  git status
  ```
- Verify syntax:
  ```powershell
  node -c src/main/index.js
  node -c src/renderer/renderer.js
  ```
- Inspect current version in `package.json`.

### 2. Version Bump
- Update `"version"` in `package.json` to the target version (e.g. `1.0.0` or `1.0.1`).
- Commit:
  ```powershell
  git add package.json
  git commit -m "chore(release): bump version to <version>"
  ```
- Push main:
  ```powershell
  $token = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
  git push "https://${token}@github.com/JagrutNakum/claude-duo.git" main
  ```

### 3. Tag and Publish
- Create tag:
  ```powershell
  git tag v<version>
  ```
- Push tag:
  ```powershell
  $token = [System.Environment]::GetEnvironmentVariable("GH_TOKEN", "User")
  git push "https://${token}@github.com/JagrutNakum/claude-duo.git" v<version>
  ```

### 4. GitHub Actions Release
GitHub Actions triggers on tag push `v*` and runs `.github/workflows/release.yml`:
- Builds `Claude-Duo-Setup-<version>.exe`
- Generates `latest.yml`
- Publishes to GitHub Releases
- Deployed users receive auto-update prompts in app.
