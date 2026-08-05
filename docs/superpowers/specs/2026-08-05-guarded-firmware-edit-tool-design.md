# Guarded Firmware Edit Tool — Design

Status: approved, not yet implemented
Date: 2026-08-05
Repository: `zmk-corne-hardened` (this repo)

## Problem

`zmk-corne-hardened` is the security-reviewed successor to `zmk-corne-oled`:
every dependency in `config/west.yml` is pinned to a reviewed commit of the
owner's own fork rather than a live upstream branch, and the hardening work
(pinning, Studio locking, immutable build-workflow reference) is already
merged to `main`. What's still missing is a safe, low-friction way to make
*ongoing* keymap changes — including changes that ZMK Studio's runtime RPC
cannot make at all (tap-dance internals, compile-time combos), which require
editing firmware source and reflashing.

The owner wants to **minimize reflashes** in general (most day-to-day keymap
work should stay on the Studio-editable path — see the companion
`dya-studio-private` project's Phase 8 completion for what that already
covers) and, for the reflashes that are genuinely unavoidable, wants the
edit → build → backup → release cycle to be mostly automated, so the only
manual, in-person step is physically entering bootloader mode and copying
the resulting firmware file onto the device.

Flashing itself, and everything immediately around it (verifying the keyboard
is in bootloader mode, confirming which half is which), must never be
automated. That boundary is non-negotiable and independent of everything
else in this design: a script or LLM never touches the physical device.

## Goals

- A CLI tool, run manually and unassisted (no interactive AI session
  required), that takes a plain-language description of a desired keymap
  change and turns it into a reviewed, committed, built, checksummed,
  released firmware artifact.
- Every step before the final manual flash is either fully automated or
  gated by an explicit yes/no confirmation you give the tool — never a
  silent write.
- Rollback that doesn't require re-running the LLM or waiting for a new CI
  build: a prior release's firmware is already sitting on disk and on
  GitHub, checksummed, the moment it's needed.
- Works with either backend LLM (OpenAI API by default, `claude -p` as a
  fallback with no API key required) behind one interface, so neither is
  load-bearing on its own.

## Non-goals

- Editing `boards/` (hardware/pin definitions), `config/west.yml` (the
  pinned dependency manifest), or root `build.yaml` (the ZMK build matrix
  — this is where `CONFIG_ZMK_STUDIO_LOCKING=y` actually lives, as a
  `cmake-args` value on the `eyelash_corne_left` build target, **not** in
  `config/eyelash_corne.conf` as originally assumed during design; verified
  by reading commit `b1626c9` directly). All three remain deliberate,
  manually-reviewed changes outside this tool's scope, always.
- Automating the physical flash step in any way (detecting bootloader mode,
  copying the file automatically, verifying which half is connected). The
  owner does this by hand, every time.
- A GitHub PR review gate (Approach 2, considered and explicitly rejected
  in favor of a direct-commit-after-confirmation flow — the confirmation
  prompt already is the review gate).
- Editing multiple keyboards/repos in one run. One request, one repo
  (`zmk-corne-hardened`), one resulting release.
- Automatically retiring `zmk-corne-oled` or migrating its history. That's
  a one-time decision for the owner to act on separately, not something
  this tool performs.

## Architecture

```text
zmk-corne-hardened/
├── config/
│   ├── eyelash_corne.keymap      <- tool may edit
│   ├── eyelash_corne.conf        <- tool may edit
│   ├── eyelash_corne.json        <- tool never touches
│   └── west.yml                  <- tool never touches
├── boards/                        <- tool never touches
├── build.yaml                     <- tool never touches (build matrix; holds
│                                     CONFIG_ZMK_STUDIO_LOCKING -- do not confuse
│                                     with .github/workflows/build.yml below)
├── .github/workflows/build.yml    <- existing, untouched; builds on push
└── tools/
    └── edit-firmware/
        ├── edit-firmware.mjs      entry point: orchestrates the full flow
        ├── llm-backend.mjs        proposes a diff via OpenAI (default) or `claude -p` (fallback)
        ├── apply-patch.mjs        validates + applies a proposed diff (the safety gate)
        ├── build-and-release.mjs  triggers build.yml, polls, downloads, checksums, publishes a GitHub Release
        ├── rollback.mjs           lists/reverts to a prior backup tag + its retained firmware
        ├── releases/              (gitignored) local copy of the last N releases + SHA256SUMS.txt
        └── __tests__/             unit tests for the pure/testable pieces
```

Node.js was chosen for this tool (matching `dya-studio-private`'s own
scripting conventions) using only `node:child_process`, `node:fs`,
`node:crypto`, `node:https`/`fetch`, and the `gh` CLI (already
authenticated on this machine) — no new heavyweight dependency.

## Components

- **`edit-firmware.mjs`** — the only command the owner runs directly:
  `node tools/edit-firmware/edit-firmware.mjs "<plain-language request>"`.
  Reads the two editable files, calls the LLM backend, shows the returned
  diff, waits for an explicit `y`/`N`, and on `y` hands off to backup,
  commit, push, and `build-and-release.mjs`. Any `N` (or anything else)
  aborts with nothing written.
- **`llm-backend.mjs`** — one exported function,
  `proposeDiff(request, files, options): Promise<string>`, with two
  implementations selected by `--backend openai|claude` (default `openai`,
  requiring `OPENAI_API_KEY` in the environment; falls back to `claude`
  automatically if the key is absent, with a printed notice). The fixed
  system instruction constrains the model to return a unified diff
  touching only `config/eyelash_corne.keymap` and `config/eyelash_corne.conf`.
  The actual HTTP/subprocess call is injectable so orchestration logic can
  be tested without hitting a real API.
- **`apply-patch.mjs`** — the safety gate, and the most heavily tested
  module. Rejects (before any write) a diff that:
  - touches any path other than the two allowed config files (`config/
    eyelash_corne.keymap`, `config/eyelash_corne.conf`) — this alone
    already keeps `build.yaml`, `boards/`, and `config/west.yml` out of
    reach, since they were never in the allowed set to begin with;
  - does not apply cleanly to the current file content;
  - fails a lightweight structural sanity check (balanced braces/brackets,
    no obviously truncated output) after applying.
  Only a diff that survives all three checks is ever shown to the owner as
  "ready to apply." (Design review originally also planned a "protected
  `.conf` settings" rule for Studio-locking-style flags; verifying the
  actual file found no such settings there — `CONFIG_ZMK_STUDIO_LOCKING`
  lives in `build.yaml`, already fully excluded by the path allowlist. That
  rule was dropped as solving a problem that didn't exist in this file,
  rather than kept as speculative extra scaffolding.)
- **`build-and-release.mjs`** — after a confirmed commit is pushed (which
  triggers `build.yml` automatically), uses the `gh` CLI to watch the
  triggered run, downloads the resulting artifacts on success, verifies
  each looks like a real UF2 image (non-trivial size, correct header) and
  computes its SHA-256, writes them plus a checksum manifest into
  `tools/edit-firmware/releases/<timestamp>-<short-sha>/`, prunes older
  local copies beyond the last 10 releases (the GitHub Release itself is
  the permanent record; the local copy is a fast-access convenience for
  `rollback.mjs`), and publishes a GitHub Release
  with the same artifacts and manifest attached (workflow-run artifacts
  expire after 90 days; Release assets don't). Prints the flash
  instructions on success; on any failure, prints the CI run link and
  stops — the previous release remains the last known-good one.
- **`rollback.mjs`** — independent of the above. `--list` shows backup
  tags newest-first with whether a release exists for each; `--to
  <tag>` reverts the source to that tag and re-surfaces that backup's
  already-built, already-checksummed release — no LLM call, no rebuild,
  nothing touched until the owner acts on the printed instructions.

## Data flow

```text
1. owner: node tools/edit-firmware/edit-firmware.mjs "<request>"
2. read config/eyelash_corne.keymap + eyelash_corne.conf
3. llm-backend.proposeDiff(request, files)         -> unified diff
4. apply-patch: validate (path allowlist, applies cleanly, structural check)
      -> any failure: report why, stop, nothing written
5. print diff, prompt "Apply this? [y/N]"
      -> not "y": stop, nothing written
6. git tag backup/<utc-timestamp>-pre-<slug> at HEAD, push the tag
      -> tag push fails: stop before any edit
7. apply patch, commit, push
      -> push fails: backup tag is already safe remotely; report
         "committed locally, not pushed" and stop (no build was
         triggered, since build.yml only runs on push)
8. push triggers build.yml (existing, unmodified)
9. build-and-release.mjs watches the run
      -> failure: print run link + summary, stop. Nothing flashed.
         Last good release untouched.
      -> success: download artifacts, verify + checksum, stage into
         releases/<ts>-<sha>/, publish as a GitHub Release, print
         checksums and flash instructions
10. owner flashes manually: bootloader mode, copy the matching .uf2
    for each half. Never automated.
```

Rollback is a separate, always-available path that doesn't depend on the
above having just run: `rollback.mjs --list`, `rollback.mjs --to <tag>`.

## Error handling summary

See the table walked through during design review (recorded here for
completeness):

| Failure | Result |
|---|---|
| LLM call fails (network/auth/rate limit/timeout) | Clear error, nothing written, suggests the other backend |
| Diff fails validation (path, doesn't apply, structural check) | Rejected before the confirmation prompt, reason shown |
| Owner declines the confirmation prompt | Abort, nothing written |
| Backup tag fails to push | Abort before any edit is made |
| Edit commit fails to push | Report clearly; backup tag already safe remotely; no build was triggered |
| CI build fails | Report run link/summary; nothing flashed; last good release untouched; rollback optional, not required |
| Artifact download fails after a successful build | Report clearly; firmware exists in CI, retry download or fetch manually |
| Downloaded artifact fails the UF2 sanity check | Refused, not staged as a release |
| Two runs started concurrently | Second run blocked by a lock file until the first finishes or is cleared |

## Testing strategy

- **Automated, fast, no network** — `apply-patch.mjs`'s three validation
  rules (the safety-critical surface), checksum computation, UF2
  sanity-check, and local release retention/pruning, all as pure-function
  fixture tests. `rollback.mjs`'s tag list/revert logic tested against a
  real scratch git repository in a temp directory.
- **Manually verified once, by design, not run automatically** —
  `llm-backend.mjs`'s real OpenAI/`claude -p` calls and
  `build-and-release.mjs`'s real `gh` orchestration. Both get an
  injectable interface so the surrounding orchestration is still unit
  tested with a fake backend, but the tool's own test suite never spends
  real API credit or triggers a real firmware build on every run.
- **Final acceptance** — one deliberate, observed end-to-end run against a
  trivial, harmless, reversible real change (e.g. a comment or label
  tweak), confirming diff → confirm → backup → build → release → rollback
  all work for real, then rolling it back. Performed once during
  implementation, not repeated automatically.

## Open questions resolved during design

- **Canonical repo:** `zmk-corne-hardened` becomes the sole firmware
  source going forward; `zmk-corne-oled` is retired (as a separate,
  owner-driven decision outside this tool's scope).
- **Interaction model:** standalone, unassisted CLI is the default;
  an interactive Claude Code session against this repo remains available
  as a fallback for anything the tool doesn't cover.
- **Tooling location:** inside `zmk-corne-hardened` itself, not a separate
  hub repo — matches the repo's own README, which already describes this
  shape.
- **LLM backend default:** OpenAI API (`OPENAI_API_KEY`), with `claude -p`
  as the no-key fallback.
- **Approach chosen:** direct commit after explicit diff confirmation
  (Approach 1), not a PR-gated flow (Approach 2) — the confirmation prompt
  already serves as the review gate.
