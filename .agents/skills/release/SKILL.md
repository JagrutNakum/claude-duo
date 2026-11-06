---
name: release
description: Release Claude-Duo. Triggers pre-flight checks, bumps version in package.json, commits, creates git tag, and pushes to GitHub to build and publish the release.
---

# Release Claude-Duo

Executes software releases for Claude-Duo via the `release-agent`.

## Usage
Type:
`/release` or `/release v1.0.0` or `/release v1.0.1`

## Workflow
1. Verify clean git working tree and JavaScript syntax.
2. Bump `"version"` in `package.json` to the target version.
3. Commit and push `main` to origin.
4. Create and push tag `v<version>` to origin.
5. GitHub Actions builds the NSIS installer and publishes the GitHub release.
