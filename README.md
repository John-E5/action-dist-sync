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

Contributors never build `dist/`, and the PR's code never runs next to a write token:
- The workflow runs on `pull_request`, never `pull_request_target`, so fork PRs only ever get a read-only token.
- The build runs in its own job, with a read-only token and no stored git credentials. A second job, which runs nothing from the PR, compares the bundle and does the commit and push.

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

The caller must grant `permissions: contents: write`, as above. Without it, on a repository whose default token is read-only, every run fails at startup. On fork PRs GitHub still gives the workflow a read-only token, whatever the caller grants.

If you use the official template's `check-dist` job, remove it. If branch protection requires a check, make it **`dist / dist is up to date`**. It fails when the build fails, too. The workflow also shows a `dist / build dist` check, which you don't need to require.

`@v0` follows the latest 0.x release. Pin `@v0.1.0` if you prefer.

| Input | Default | |
|---|---|---|
| `build-command` | `npm ci && npm run build` | Builds the bundle |
| `dist-path` | `dist` | The committed bundle folder |
| `node-version` | `22` | |
| `artifact-name` | `action-dist` | Artifact name on fork PRs |

### push-token (optional)

GitHub doesn't start new workflow runs for a push made with the default `GITHUB_TOKEN`. So after the workflow commits the bundle to a same-repo PR, the new commit has no checks, and a required check stays pending.

Fix this with a fine-grained PAT in the `push-token` secret, with Contents read/write on this repo only. Without one, re-run the checks from the PR page, or push an empty commit.

**Dependabot:** Dependabot PRs can't read your Actions secrets, so add `DIST_PUSH_TOKEN` under the repository's Dependabot secrets too. Without it, the sync commit on a Dependabot PR is pushed with `GITHUB_TOKEN`, and its checks don't run again.

If the bundle still differs straight after a sync commit, the workflow fails instead of pushing again: the build isn't deterministic on the runner.

### After the bot commits

On a same-repo PR the bot adds a commit to the branch. Pull it before you push again, or your push is rejected.

## The maintainer command

```bash
npx action-dist-sync <pr> [--repo owner/name] [--dist-path dist] [--workflow dist.yml] [--artifact action-dist]
```

**Requirements:**
- The [GitHub CLI](https://cli.github.com), signed in. The clone and push use gh's credentials directly, whatever credential helper git has, and never prompt. No `gh auth setup-git` is needed.
- `git` on PATH, with your name and email configured for the commit.
- "Allow edits by maintainers" ticked on the PR.

**Review first.** The artifact is built by the fork's own code, including its build scripts and `package.json`. Before applying it, review any changes to how the bundle is built, just as you review the source.

**It checks before touching anything:**
- The PR must come from a fork that still exists.
- Maintainers must be allowed to edit it.
- The workflow run for the head commit must have finished.

If that run passed, CI already found the bundle in sync, so it stops there and changes nothing. Otherwise it downloads the artifact.

**Then it:**
1. Shallow-clones the fork branch, and checks the branch hasn't moved past the commit the run built.
2. Replaces `dist-path` with the artifact. It refuses if `dist-path`, or a folder above it, is a symlink in the fork.
3. Commits `build: sync dist bundle`, and pushes. If the bundle already matches, it stops and changes nothing.

**Defaults:** `--repo` defaults to the repository in the current folder, and `--workflow` matches the file name of your caller workflow (`dist.yml` above). `--dist-path` must be a folder inside the repository; it can't contain `..` past the root, a `:`, or a `.git` folder.

**Exit codes:**
- **0:** it pushed the bundle, or the bundle was already in sync.
- **1:** the PR can't be synced as it stands, and the message says why. For example: it isn't from a fork, the fork was deleted, maintainer edits are off, the run hasn't finished, the artifact is missing or expired, the branch moved since the run, or `dist-path` is a symlink.
- **2:** a setup or tool problem, with the `gh` or `git` error. For example: `gh` is missing or signed out, a download or push failed, or the arguments are invalid.

## Requirements

Node 22 or later for the CLI. The workflow runs on `ubuntu-latest`.

---

Extracted from [drift-ci](https://github.com/Drift-CI/drift-ci), whose GitHub Action has used this flow for every PR since it went public. Verified end to end on GitHub (November 2026): a same-repo PR got the rebuilt bundle committed, and a fork PR failed with the sync command, which applied the bundle and turned it green. MIT licensed.
