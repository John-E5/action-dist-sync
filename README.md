# action-dist-sync

**Fork PRs for JavaScript GitHub Actions, without the dist/ dance.** CI builds your Action's bundle. Same-repo PRs get it committed automatically, and fork PRs get it applied with one maintainer command.

```
$ npx action-dist-sync 42
Downloading action-dist from run 9876543210
Cloning contributor/my-action:fix-typo
Pushing to contributor/my-action:fix-typo
Pushed the CI-built bundle to contributor/my-action:fix-typo. The PR's checks will run again.
```

## The problem

JavaScript Actions commit a built `dist/` (from ncc, esbuild or Rollup), because GitHub runs the Action straight from the repo. But the bundle isn't reproducible across machines: module order, line endings and dependency versions all leak in. So:

- **Contributors** have to build `dist/` themselves, and their bundle rarely matches CI byte for byte.
- **The usual `check-dist` job** (from the official template) can only fail. It detects the drift, but it can't fix it.
- **Fork PRs are worst:** CI can't push to a fork, so someone has to rebuild and push by hand.

## How it works

1. A reusable workflow rebuilds `dist/` on every PR.
2. If the bundle matches, it passes. **Same-repo PR:** it commits the rebuilt bundle to the branch. **Fork PR:** it uploads the bundle as an artifact and fails with a clear message.
3. A maintainer runs `npx action-dist-sync <pr>`. That applies the artifact to the fork's branch, using "Allow edits by maintainers", and the checks run again.

Contributors never build `dist/`, and fork code never gets a write token: the workflow runs on `pull_request`, never `pull_request_target`.

## Setup

Add `.github/workflows/dist.yml`:

```yaml
name: dist
on: pull_request
permissions:
  contents: write
jobs:
  dist:
    uses: John-E5/action-dist-sync/.github/workflows/sync.yml@v0
    with:
      build-command: npm ci && npm run build # whatever builds your bundle
      dist-path: dist
    # secrets:
    #   push-token: ${{ secrets.DIST_PUSH_TOKEN }}  # optional, see below
```

If you use the official template's `check-dist` job, remove it. If branch protection requires a check, make it **`dist / dist is up to date`**.

`@v0` follows the latest 0.x release. Pin `@v0.1.0` if you prefer.

| Input | Default | |
|---|---|---|
| `build-command` | `npm ci && npm run build` | Builds the bundle |
| `dist-path` | `dist` | The committed bundle folder |
| `node-version` | `22` | |
| `artifact-name` | `action-dist` | Artifact name on fork PRs |

### push-token (optional)

GitHub doesn't start new workflow runs for a push made with the default `GITHUB_TOKEN`. So after the workflow commits the bundle to a same-repo PR, the new commit has no checks, and a required check stays pending.

Fix this with a token in the `push-token` secret: a fine-grained PAT with Contents read/write on this repo, or a GitHub App token. Without one, re-run the checks from the PR page, or push an empty commit.

## The maintainer command

```bash
npx action-dist-sync <pr> [--repo owner/name] [--dist-path dist] [--workflow dist.yml] [--artifact action-dist]
```

**Requirements:**
- The [GitHub CLI](https://cli.github.com), signed in. The clone and push use gh's credentials directly, whatever credential helper git has, and never prompt. No `gh auth setup-git` is needed.
- `git` on PATH, with your name and email configured for the commit.
- "Allow edits by maintainers" ticked on the PR.

**It checks before touching anything:** the PR must come from a fork, maintainers must be allowed to edit it, and the workflow run for the head commit must have finished with the artifact present.

**Then it:**
1. Shallow-clones the fork branch.
2. Replaces `dist-path` with the artifact.
3. Commits `build: sync dist bundle`, and pushes.

If the bundle already matches, it stops and changes nothing.

**Defaults:** `--repo` defaults to the repository in the current folder, and `--workflow` matches the file name of your caller workflow (`dist.yml` above).

**Exit codes:** 0 when it pushed the bundle or there was nothing to do; 1 when the PR can't be synced yet (the message says why); 2 for a setup or tool problem.

## Requirements

Node 22 or later for the CLI. The workflow runs on `ubuntu-latest`.

---

Extracted from [drift-ci](https://github.com/Drift-CI/drift-ci), whose GitHub Action has used this flow for every PR since it went public. MIT licensed.
