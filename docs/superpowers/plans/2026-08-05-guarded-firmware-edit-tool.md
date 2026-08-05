# Guarded Firmware Edit Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone CLI, run manually and unassisted, that turns a plain-language keymap change request into a reviewed, committed, built, checksummed, and GitHub-Released firmware artifact for `zmk-corne-hardened` — with the physical flash step always left to the owner.

**Architecture:** Node.js ES modules under `tools/edit-firmware/`, using only Node core APIs, the `git` CLI, and the `gh` CLI (already authenticated on this machine) — no new npm dependency. An LLM backend (OpenAI API by default, `claude -p` as a no-key fallback) proposes complete new content for one or both of exactly two editable files; the tool never applies an LLM-generated unified diff (see Deviation below). Every write is preceded by an explicit `y`/`N` confirmation showing a real `git diff`.

**Tech Stack:** Node.js (`node:test` for tests, `node:child_process`, `node:fs`, `node:crypto`, `node:readline`, `fetch`), `git`, `gh` CLI.

## Deviation from the approved spec (found during planning, not implementation)

The spec (`docs/superpowers/specs/2026-08-05-guarded-firmware-edit-tool-design.md`)
describes the LLM returning a "unified diff." During planning this was changed
to: **the LLM returns the complete new content of each file it changes**,
identified by exact relative path. The tool writes that content directly into
the real working tree (which is already a git checkout) and uses `git diff`
itself to display the pending change and `git checkout --` to discard it if
declined. This preserves every safety property the spec describes (path
allowlist, explicit confirmation before any write survives, structural
check, rollback) while removing an entire class of fragile diff-parsing/
patch-application failures that come from applying an LLM-authored unified
diff whose context lines don't quite match. Git's own diff/checkout
machinery is already a hard dependency of the whole workflow, is well-tested,
and needs no new code to parse a patch format.

## Global Constraints

- Editable paths, exactly: `config/eyelash_corne.keymap`,
  `config/eyelash_corne.conf`. Nothing else, ever — not `boards/`, not
  root `build.yaml` (holds `CONFIG_ZMK_STUDIO_LOCKING`), not
  `config/west.yml`.
- The physical flash step (bootloader entry, copying the `.uf2`, verifying
  which half is which) is never automated by any code in this plan.
- No new npm dependency. Node core + `git` + `gh` only.
- Local release retention: keep the newest 10 release folders under
  `tools/edit-firmware/releases/`; GitHub Releases are the permanent record.
- Every step that writes to the repo, pushes, or calls a paid API must be
  preceded by a check that can abort cleanly with nothing written/pushed.
- Tests for `apply-patch`, `structural-check`, `checksum`, `release-store`,
  and the rollback logic in `git-helpers` are real, automated, and run with
  `node --test`. Tests for the real OpenAI/`claude -p` calls and the real
  `gh` orchestration are NOT part of the automated suite (would spend money
  / trigger real firmware builds on every run) — those get a manual
  verification step instead, called out explicitly in their tasks.

---

### Task 1: Project scaffold

**Files:**
- Create: `tools/edit-firmware/package.json`
- Create: `tools/edit-firmware/.gitignore`
- Create: `tools/edit-firmware/src/config.mjs`
- Create: `tools/edit-firmware/src/__tests__/config.test.mjs`

**Interfaces:**
- Produces: `ALLOWED_EDIT_PATHS: string[]`, `RELEASES_DIR: string`,
  `RELEASE_RETENTION_COUNT: number`, `LOCK_FILE_PATH: string`,
  `DEFAULT_LLM_BACKEND: "openai"`, `BACKUP_TAG_PREFIX: "backup/"` — every
  later task imports these from `config.mjs` rather than re-declaring them.

- [ ] **Step 1: Write `tools/edit-firmware/package.json`**

```json
{
  "name": "edit-firmware",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "node --test src/__tests__/"
  }
}
```

- [ ] **Step 2: Write `tools/edit-firmware/.gitignore`**

```text
node_modules
releases
.edit-firmware.lock
```

- [ ] **Step 3: Write the failing test `tools/edit-firmware/src/__tests__/config.test.mjs`**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_EDIT_PATHS,
  RELEASES_DIR,
  RELEASE_RETENTION_COUNT,
  LOCK_FILE_PATH,
  DEFAULT_LLM_BACKEND,
  BACKUP_TAG_PREFIX,
} from "../config.mjs";

test("ALLOWED_EDIT_PATHS is exactly the two editable config files", () => {
  assert.deepEqual(ALLOWED_EDIT_PATHS, [
    "config/eyelash_corne.keymap",
    "config/eyelash_corne.conf",
  ]);
});

test("ALLOWED_EDIT_PATHS never contains boards/, build.yaml, or west.yml", () => {
  for (const path of ALLOWED_EDIT_PATHS) {
    assert.ok(!path.startsWith("boards/"), `${path} must not be under boards/`);
    assert.notEqual(path, "build.yaml");
    assert.notEqual(path, "config/west.yml");
  }
});

test("retention and defaults are sane", () => {
  assert.equal(RELEASE_RETENTION_COUNT, 10);
  assert.equal(DEFAULT_LLM_BACKEND, "openai");
  assert.equal(BACKUP_TAG_PREFIX, "backup/");
  assert.ok(RELEASES_DIR.includes("releases"));
  assert.ok(LOCK_FILE_PATH.includes(".edit-firmware.lock"));
});
```

- [ ] **Step 4: Run test to verify it fails**

Run (from `zmk-corne-hardened/tools/edit-firmware/`):
`node --test src/__tests__/config.test.mjs`
Expected: FAIL — `Cannot find module '../config.mjs'`

- [ ] **Step 5: Write `tools/edit-firmware/src/config.mjs`**

```javascript
/**
 * Shared constants for the guarded firmware edit tool. Every other module
 * imports paths and limits from here rather than re-declaring them, so
 * there is exactly one place that defines "what this tool is allowed to
 * touch."
 */
export const ALLOWED_EDIT_PATHS = [
  "config/eyelash_corne.keymap",
  "config/eyelash_corne.conf",
];

export const RELEASES_DIR = "tools/edit-firmware/releases";
export const RELEASE_RETENTION_COUNT = 10;
export const LOCK_FILE_PATH = "tools/edit-firmware/.edit-firmware.lock";
export const DEFAULT_LLM_BACKEND = "openai";
export const BACKUP_TAG_PREFIX = "backup/";
export const BUILD_WORKFLOW_FILE = "build.yml";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test src/__tests__/config.test.mjs`
Expected: PASS, 3/3 tests

- [ ] **Step 7: Commit**

```bash
git add tools/edit-firmware/package.json tools/edit-firmware/.gitignore tools/edit-firmware/src/config.mjs tools/edit-firmware/src/__tests__/config.test.mjs
git commit -m "feat(edit-firmware): scaffold project and shared constants"
```

---

### Task 2: Structural sanity checks

**Files:**
- Create: `tools/edit-firmware/src/structural-check.mjs`
- Create: `tools/edit-firmware/src/__tests__/structural-check.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `checkKeymapStructure(content: string): {ok: boolean, reason: string|null}`,
  `checkConfStructure(content: string): {ok: boolean, reason: string|null}`,
  `checkStructureForPath(relativePath: string, content: string): {ok: boolean, reason: string|null}`
  — Task 3 (`apply-patch.mjs`) calls `checkStructureForPath` by exact name.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/structural-check.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkKeymapStructure,
  checkConfStructure,
  checkStructureForPath,
} from "../structural-check.mjs";

test("checkKeymapStructure accepts balanced braces and angle brackets", () => {
  const content = `
/ {
    keymap {
        compatible = "zmk,keymap";
        default_layer {
            bindings = <&kp A &kp B>;
        };
    };
};
`;
  assert.deepEqual(checkKeymapStructure(content), { ok: true, reason: null });
});

test("checkKeymapStructure rejects unbalanced braces", () => {
  const content = "/ { keymap { bindings = <&kp A>; };";
  const result = checkKeymapStructure(content);
  assert.equal(result.ok, false);
  assert.match(result.reason, /brace/i);
});

test("checkKeymapStructure rejects unbalanced angle brackets", () => {
  const content = "/ { keymap { bindings = <&kp A; }; };";
  const result = checkKeymapStructure(content);
  assert.equal(result.ok, false);
  assert.match(result.reason, /angle bracket/i);
});

test("checkKeymapStructure rejects empty content", () => {
  const result = checkKeymapStructure("");
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("checkConfStructure accepts KEY=value lines, blank lines, and comments", () => {
  const content = [
    "# a comment",
    "",
    "CONFIG_ZMK_SLEEP=y",
    "CONFIG_ZMK_IDLE_SLEEP_TIMEOUT=3600000",
    "",
  ].join("\n");
  assert.deepEqual(checkConfStructure(content), { ok: true, reason: null });
});

test("checkConfStructure rejects a line that isn't a comment, blank, or KEY=value", () => {
  const content = "CONFIG_ZMK_SLEEP=y\nthis is not a config line\n";
  const result = checkConfStructure(content);
  assert.equal(result.ok, false);
  assert.match(result.reason, /line 2/);
});

test("checkConfStructure rejects empty content", () => {
  const result = checkConfStructure("");
  assert.equal(result.ok, false);
  assert.match(result.reason, /empty/i);
});

test("checkStructureForPath dispatches by extension", () => {
  assert.equal(
    checkStructureForPath("config/eyelash_corne.conf", "CONFIG_ZMK_SLEEP=y\n").ok,
    true,
  );
  assert.equal(
    checkStructureForPath("config/eyelash_corne.keymap", "/ {};").ok,
    true,
  );
});

test("checkStructureForPath rejects an unrecognized extension defensively", () => {
  const result = checkStructureForPath("config/eyelash_corne.json", "{}");
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrecognized/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/__tests__/structural-check.test.mjs`
Expected: FAIL — `Cannot find module '../structural-check.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/structural-check.mjs`**

```javascript
/**
 * Lightweight, dependency-free sanity checks run on LLM-proposed file
 * content before it is ever shown to the owner as "ready to apply." These
 * are NOT a devicetree/Kconfig parser -- they catch obviously broken or
 * truncated output cheaply. The real correctness gate is the actual ZMK/
 * Zephyr build in CI; these checks only avoid wasting a build (or worse,
 * committing garbage) on output that's clearly malformed.
 */
function countChar(content, char) {
  let count = 0;
  for (const ch of content) if (ch === char) count += 1;
  return count;
}

export function checkKeymapStructure(content) {
  if (content.trim().length === 0) {
    return { ok: false, reason: "File content is empty." };
  }
  const openBraces = countChar(content, "{");
  const closeBraces = countChar(content, "}");
  if (openBraces !== closeBraces) {
    return {
      ok: false,
      reason: `Unbalanced curly braces: ${openBraces} "{" vs ${closeBraces} "}".`,
    };
  }
  const openAngles = countChar(content, "<");
  const closeAngles = countChar(content, ">");
  if (openAngles !== closeAngles) {
    return {
      ok: false,
      reason: `Unbalanced angle brackets: ${openAngles} "<" vs ${closeAngles} ">".`,
    };
  }
  const openParens = countChar(content, "(");
  const closeParens = countChar(content, ")");
  if (openParens !== closeParens) {
    return {
      ok: false,
      reason: `Unbalanced parentheses: ${openParens} "(" vs ${closeParens} ")".`,
    };
  }
  return { ok: true, reason: null };
}

const CONF_LINE_PATTERN = /^[A-Za-z0-9_]+=.*$/;

export function checkConfStructure(content) {
  if (content.trim().length === 0) {
    return { ok: false, reason: "File content is empty." };
  }
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line.startsWith("#")) continue;
    if (!CONF_LINE_PATTERN.test(line)) {
      return {
        ok: false,
        reason: `Line ${i + 1} is not a comment, blank line, or KEY=value setting: "${lines[i]}"`,
      };
    }
  }
  return { ok: true, reason: null };
}

export function checkStructureForPath(relativePath, content) {
  if (relativePath.endsWith(".keymap")) return checkKeymapStructure(content);
  if (relativePath.endsWith(".conf")) return checkConfStructure(content);
  return {
    ok: false,
    reason: `Unrecognized file extension for structural check: ${relativePath}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/structural-check.test.mjs`
Expected: PASS, 8/8 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/structural-check.mjs tools/edit-firmware/src/__tests__/structural-check.test.mjs
git commit -m "feat(edit-firmware): add structural sanity checks for keymap/conf content"
```

---

### Task 3: Path-scoped patch validation and staging (the safety gate)

**Files:**
- Create: `tools/edit-firmware/src/apply-patch.mjs`
- Create: `tools/edit-firmware/src/__tests__/apply-patch.test.mjs`

**Interfaces:**
- Consumes: `ALLOWED_EDIT_PATHS` from `config.mjs` (Task 1);
  `checkStructureForPath` from `structural-check.mjs` (Task 2).
- Produces: `validateProposedFiles(proposedFiles: Record<string,string>): {ok: boolean, reasons: string[]}`,
  `stageFiles(repoRoot: string, proposedFiles: Record<string,string>): void`,
  `diffStaged(repoRoot: string, paths: string[]): string`,
  `discardStaged(repoRoot: string, paths: string[]): void`
  — Task 11 (`edit-firmware.mjs`) calls all four by exact name.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/apply-patch.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  validateProposedFiles,
  stageFiles,
  diffStaged,
  discardStaged,
} from "../apply-patch.mjs";

function makeScratchRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "edit-firmware-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  const configDir = path.join(dir, "config");
  execFileSync("mkdir", [configDir]).toString(); // will be replaced below if mkdir unavailable
  return dir;
}

test("validateProposedFiles accepts a single allowed path", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": "/ {};",
  });
  assert.deepEqual(result, { ok: true, reasons: [] });
});

test("validateProposedFiles rejects a disallowed path even alongside an allowed one", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": "/ {};",
    "boards/shields/eyelash_corne/eyelash_corne.overlay": "// nope",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("boards/shields/eyelash_corne/eyelash_corne.overlay")));
});

test("validateProposedFiles rejects build.yaml and config/west.yml by name", () => {
  const result = validateProposedFiles({
    "build.yaml": "include: []",
    "config/west.yml": "manifest: {}",
  });
  assert.equal(result.ok, false);
  assert.equal(result.reasons.length, 2);
});

test("validateProposedFiles rejects content that fails the structural check", () => {
  const result = validateProposedFiles({
    "config/eyelash_corne.keymap": "/ { unbalanced",
  });
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("brace")));
});

test("validateProposedFiles rejects an empty proposal", () => {
  const result = validateProposedFiles({});
  assert.equal(result.ok, false);
  assert.ok(result.reasons.some((r) => r.includes("No files")));
});

test("stageFiles writes content, diffStaged shows it, discardStaged reverts it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "edit-firmware-test-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    const keymapPath = path.join(dir, "config", "eyelash_corne.keymap");
    writeFileSync(keymapPath, "/ { original = <1>; };\n", { flag: "wx" });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir });

    stageFiles(dir, { "config/eyelash_corne.keymap": "/ { changed = <2>; };\n" });
    const diff = diffStaged(dir, ["config/eyelash_corne.keymap"]);
    assert.match(diff, /-\/ \{ original = <1>; \};/);
    assert.match(diff, /\+\/ \{ changed = <2>; \};/);
    assert.equal(readFileSync(keymapPath, "utf8"), "/ { changed = <2>; };\n");

    discardStaged(dir, ["config/eyelash_corne.keymap"]);
    assert.equal(readFileSync(keymapPath, "utf8"), "/ { original = <1>; };\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Fix the test's scratch-repo setup and run to verify it fails**

The first `makeScratchRepo()` helper above uses `execFileSync("mkdir", ...)`
which does not exist as a standalone executable on Windows outside a shell.
Replace that unused/broken helper before running — the real second test
already does directory creation correctly via `writeFileSync(..., {flag:
"wx"})` after creating the `config` directory with `node:fs`'s `mkdirSync`.
Update the test file: delete the `makeScratchRepo` function entirely (it is
unused by any test) and add `import { mkdirSync } from "node:fs";` plus
`mkdirSync(path.join(dir, "config"), { recursive: true });` immediately
after the last `git config` call in the "stageFiles writes content..." test,
before the `writeFileSync` call.

Run: `node --test src/__tests__/apply-patch.test.mjs`
Expected: FAIL — `Cannot find module '../apply-patch.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/apply-patch.mjs`**

```javascript
/**
 * The safety gate between an LLM's proposed file content and the real
 * working tree. Nothing here ever executes what it validates -- it only
 * decides whether a proposal is even eligible to be shown to the owner as
 * "ready to apply."
 *
 * Design note: earlier drafts of this tool planned to apply an LLM-
 * generated unified diff. That was changed during implementation planning
 * to "the LLM returns complete new file content" -- see the plan's
 * "Deviation from the approved spec" section. This module writes that
 * content directly into the real working tree (already a git checkout)
 * and uses `git diff`/`git checkout --` for display and discard, rather
 * than parsing and applying a patch format itself.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { ALLOWED_EDIT_PATHS } from "./config.mjs";
import { checkStructureForPath } from "./structural-check.mjs";

export function validateProposedFiles(proposedFiles) {
  const reasons = [];
  const paths = Object.keys(proposedFiles);

  if (paths.length === 0) {
    return { ok: false, reasons: ["No files were proposed."] };
  }

  for (const relativePath of paths) {
    if (!ALLOWED_EDIT_PATHS.includes(relativePath)) {
      reasons.push(
        `"${relativePath}" is not an editable path. Only ${ALLOWED_EDIT_PATHS.join(", ")} may be changed by this tool.`,
      );
      continue;
    }
    const structural = checkStructureForPath(relativePath, proposedFiles[relativePath]);
    if (!structural.ok) {
      reasons.push(`"${relativePath}" failed its structural check: ${structural.reason}`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export function stageFiles(repoRoot, proposedFiles) {
  for (const [relativePath, content] of Object.entries(proposedFiles)) {
    writeFileSync(path.join(repoRoot, relativePath), content, "utf8");
  }
}

export function diffStaged(repoRoot, paths) {
  return execFileSync("git", ["diff", "--", ...paths], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

export function discardStaged(repoRoot, paths) {
  execFileSync("git", ["checkout", "--", ...paths], { cwd: repoRoot });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/apply-patch.test.mjs`
Expected: PASS, 6/6 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/apply-patch.mjs tools/edit-firmware/src/__tests__/apply-patch.test.mjs
git commit -m "feat(edit-firmware): add the path-scoped patch validation and staging gate"
```

---

### Task 4: Checksums and UF2 sanity check

**Files:**
- Create: `tools/edit-firmware/src/checksum.mjs`
- Create: `tools/edit-firmware/src/__tests__/checksum.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `sha256File(filePath: string): string` (lowercase hex digest),
  `looksLikeUf2(filePath: string): boolean` — Task 5 (`release-store.mjs`)
  and Task 10 (`github-actions.mjs`) call both by exact name.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/checksum.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sha256File, looksLikeUf2 } from "../checksum.mjs";

test("sha256File matches a hash computed independently", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "sample.bin");
    const content = Buffer.from("hello firmware");
    writeFileSync(filePath, content);
    const expected = createHash("sha256").update(content).digest("hex");
    assert.equal(sha256File(filePath), expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeUf2 accepts a file with the correct magic number and block size", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "firmware.uf2");
    const block = Buffer.alloc(512);
    block.writeUInt32LE(0x0a324655, 0); // UF2 MagicStart0
    writeFileSync(filePath, block);
    assert.equal(looksLikeUf2(filePath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeUf2 rejects a file with the wrong magic number", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "not-firmware.bin");
    writeFileSync(filePath, Buffer.alloc(512));
    assert.equal(looksLikeUf2(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looksLikeUf2 rejects a file that isn't a multiple of the 512-byte block size", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "checksum-test-"));
  try {
    const filePath = path.join(dir, "truncated.uf2");
    const block = Buffer.alloc(300);
    block.writeUInt32LE(0x0a324655, 0);
    writeFileSync(filePath, block);
    assert.equal(looksLikeUf2(filePath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/__tests__/checksum.test.mjs`
Expected: FAIL — `Cannot find module '../checksum.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/checksum.mjs`**

```javascript
/**
 * Checksum and basic UF2-shape verification for downloaded firmware
 * artifacts. The UF2 check is deliberately shallow (magic number + block
 * alignment) -- it exists only to catch an obviously corrupt or truncated
 * download before it's staged as a release, not to fully validate firmware
 * contents.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const UF2_MAGIC_START_0 = 0x0a324655;
const UF2_BLOCK_SIZE = 512;

export function sha256File(filePath) {
  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

export function looksLikeUf2(filePath) {
  const size = statSync(filePath).size;
  if (size === 0 || size % UF2_BLOCK_SIZE !== 0) return false;
  const handle = readFileSync(filePath);
  const magic = handle.readUInt32LE(0);
  return magic === UF2_MAGIC_START_0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/checksum.test.mjs`
Expected: PASS, 4/4 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/checksum.mjs tools/edit-firmware/src/__tests__/checksum.test.mjs
git commit -m "feat(edit-firmware): add checksum and UF2 sanity-check helpers"
```

---

### Task 5: Local release staging and retention

**Files:**
- Create: `tools/edit-firmware/src/release-store.mjs`
- Create: `tools/edit-firmware/src/__tests__/release-store.test.mjs`

**Interfaces:**
- Consumes: `sha256File` from `checksum.mjs` (Task 4); `RELEASE_RETENTION_COUNT`
  from `config.mjs` (Task 1).
- Produces: `stageRelease(releasesDir: string, releaseId: string, artifactPaths: string[]): string`
  (returns the created release directory path), `pruneOldReleases(releasesDir: string, retentionCount: number): string[]`
  (returns pruned directory names), `listReleases(releasesDir: string): string[]`
  (newest first) — Task 10 (`github-actions.mjs`) and Task 12 (`rollback.mjs`)
  call all three by exact name.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/release-store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stageRelease, pruneOldReleases, listReleases } from "../release-store.mjs";

function withTempReleasesDir(run) {
  const dir = mkdtempSync(path.join(tmpdir(), "release-store-test-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("stageRelease copies artifacts and writes a checksum manifest", () => {
  withTempReleasesDir((releasesDir) => {
    const sourceDir = mkdtempSync(path.join(tmpdir(), "artifacts-"));
    const artifactPath = path.join(sourceDir, "eyelash_corne_left.uf2");
    writeFileSync(artifactPath, "fake firmware bytes");

    const releaseDir = stageRelease(releasesDir, "20260805T120000Z-abc1234", [artifactPath]);

    assert.ok(existsSync(path.join(releaseDir, "eyelash_corne_left.uf2")));
    const manifest = readFileSync(path.join(releaseDir, "SHA256SUMS.txt"), "utf8");
    assert.match(manifest, /eyelash_corne_left\.uf2/);
    assert.match(manifest, /^[0-9a-f]{64} {2}eyelash_corne_left\.uf2$/m);

    rmSync(sourceDir, { recursive: true, force: true });
  });
});

test("listReleases returns release directory names newest first", () => {
  withTempReleasesDir((releasesDir) => {
    mkdirSync(path.join(releasesDir, "20260101T000000Z-aaa1111"));
    mkdirSync(path.join(releasesDir, "20260805T000000Z-bbb2222"));
    mkdirSync(path.join(releasesDir, "20260301T000000Z-ccc3333"));

    assert.deepEqual(listReleases(releasesDir), [
      "20260805T000000Z-bbb2222",
      "20260301T000000Z-ccc3333",
      "20260101T000000Z-aaa1111",
    ]);
  });
});

test("listReleases returns an empty array when the releases directory doesn't exist yet", () => {
  withTempReleasesDir((releasesDir) => {
    assert.deepEqual(listReleases(path.join(releasesDir, "does-not-exist")), []);
  });
});

test("pruneOldReleases removes everything beyond the retention count, oldest first", () => {
  withTempReleasesDir((releasesDir) => {
    mkdirSync(path.join(releasesDir, "20260101T000000Z-a"));
    mkdirSync(path.join(releasesDir, "20260201T000000Z-b"));
    mkdirSync(path.join(releasesDir, "20260301T000000Z-c"));

    const pruned = pruneOldReleases(releasesDir, 2);

    assert.deepEqual(pruned, ["20260101T000000Z-a"]);
    assert.deepEqual(listReleases(releasesDir), [
      "20260301T000000Z-c",
      "20260201T000000Z-b",
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/__tests__/release-store.test.mjs`
Expected: FAIL — `Cannot find module '../release-store.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/release-store.mjs`**

```javascript
/**
 * Manages the local, gitignored copy of built firmware releases under
 * tools/edit-firmware/releases/. This is a fast-access convenience for
 * rollback.mjs -- the GitHub Release (created by github-actions.mjs) is
 * the permanent record, since local copies are pruned.
 */
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { sha256File } from "./checksum.mjs";

export function stageRelease(releasesDir, releaseId, artifactPaths) {
  const releaseDir = path.join(releasesDir, releaseId);
  mkdirSync(releaseDir, { recursive: true });

  const manifestLines = [];
  for (const artifactPath of artifactPaths) {
    const fileName = path.basename(artifactPath);
    copyFileSync(artifactPath, path.join(releaseDir, fileName));
    manifestLines.push(`${sha256File(artifactPath)}  ${fileName}`);
  }
  writeFileSync(
    path.join(releaseDir, "SHA256SUMS.txt"),
    manifestLines.join("\n") + "\n",
    "utf8",
  );

  return releaseDir;
}

export function listReleases(releasesDir) {
  if (!existsSync(releasesDir)) return [];
  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
}

export function pruneOldReleases(releasesDir, retentionCount) {
  const releases = listReleases(releasesDir); // newest first
  const toPrune = releases.slice(retentionCount); // everything beyond retention
  for (const releaseId of toPrune) {
    rmSync(path.join(releasesDir, releaseId), { recursive: true, force: true });
  }
  return toPrune.reverse(); // oldest-pruned-first, matching the test's expectation
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/release-store.test.mjs`
Expected: PASS, 4/4 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/release-store.mjs tools/edit-firmware/src/__tests__/release-store.test.mjs
git commit -m "feat(edit-firmware): add local release staging, listing, and pruning"
```

---

### Task 6: Git backup/commit/rollback helpers

**Files:**
- Create: `tools/edit-firmware/src/git-helpers.mjs`
- Create: `tools/edit-firmware/src/__tests__/git-helpers.test.mjs`

**Interfaces:**
- Consumes: `ALLOWED_EDIT_PATHS`, `BACKUP_TAG_PREFIX` from `config.mjs` (Task 1).
- Produces: `currentHeadSha(repoRoot: string): string`,
  `createBackupTag(repoRoot: string, slug: string): string` (returns the
  created tag name, throws if the tag push fails),
  `commitAndPush(repoRoot: string, message: string, paths: string[]): {pushed: boolean, sha: string}`,
  `listBackupTags(repoRoot: string): string[]` (newest first),
  `revertConfigToTag(repoRoot: string, tagName: string): {sha: string}`
  (restores `ALLOWED_EDIT_PATHS` to their content at `tagName` as a new
  commit — never a destructive reset, never a force-push) — Task 11
  (`edit-firmware.mjs`) and Task 12 (`rollback.mjs`) call all five by exact
  name.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/git-helpers.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  currentHeadSha,
  listBackupTags,
  revertConfigToTag,
} from "../git-helpers.mjs";

// createBackupTag and commitAndPush both push to a remote, so they are
// exercised against a local bare repo acting as "origin" rather than a
// real GitHub remote -- this proves the push mechanics without any
// network access or real credentials.
function makeRepoWithRemote() {
  const remoteDir = mkdtempSync(path.join(tmpdir(), "git-helpers-remote-"));
  execFileSync("git", ["init", "-q", "--bare", "-b", "main"], { cwd: remoteDir });

  const workDir = mkdtempSync(path.join(tmpdir(), "git-helpers-work-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: workDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: workDir });
  execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: workDir });

  mkdirSync(path.join(workDir, "config"), { recursive: true });
  writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <1>; };\n");
  writeFileSync(path.join(workDir, "config", "eyelash_corne.conf"), "CONFIG_ZMK_SLEEP=y\n");
  execFileSync("git", ["add", "-A"], { cwd: workDir });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: workDir });
  execFileSync("git", ["push", "-q", "-u", "origin", "main"], { cwd: workDir });

  return { workDir, remoteDir };
}

test("currentHeadSha returns the real HEAD commit sha", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    const sha = currentHeadSha(workDir);
    const expected = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
    assert.equal(sha, expected);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("revertConfigToTag restores the two editable files to their content at a tag, as a new commit", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/before-change"], { cwd: workDir });
    const beforeSha = currentHeadSha(workDir);

    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <2>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "a risky change"], { cwd: workDir });
    const afterChangeSha = currentHeadSha(workDir);
    assert.notEqual(afterChangeSha, beforeSha);

    const result = revertConfigToTag(workDir, "backup/before-change");

    assert.notEqual(result.sha, afterChangeSha, "revert must create a NEW commit, not reset HEAD");
    assert.equal(
      readFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "utf8"),
      "/ { v = <1>; };\n",
    );
    // History is preserved -- the risky commit is still reachable, not destroyed.
    const log = execFileSync("git", ["log", "--oneline"], { cwd: workDir, encoding: "utf8" });
    assert.match(log, /a risky change/);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});

test("listBackupTags returns backup/ tags newest first", () => {
  const { workDir, remoteDir } = makeRepoWithRemote();
  try {
    execFileSync("git", ["tag", "backup/2026-01-01-first"], { cwd: workDir });
    writeFileSync(path.join(workDir, "config", "eyelash_corne.keymap"), "/ { v = <2>; };\n");
    execFileSync("git", ["commit", "-q", "-am", "second change"], { cwd: workDir });
    execFileSync("git", ["tag", "backup/2026-01-02-second"], { cwd: workDir });
    execFileSync("git", ["tag", "not-a-backup-tag"], { cwd: workDir });

    const tags = listBackupTags(workDir);
    assert.deepEqual(tags, ["backup/2026-01-02-second", "backup/2026-01-01-first"]);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(remoteDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/__tests__/git-helpers.test.mjs`
Expected: FAIL — `Cannot find module '../git-helpers.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/git-helpers.mjs`**

```javascript
/**
 * Git operations for the guarded firmware edit tool. Deliberately never
 * uses `git reset --hard` or a force-push anywhere: rollback restores the
 * two editable files to a prior tag's content as a brand-new commit, so
 * history is always additive and nothing already pushed is ever rewritten.
 */
import { execFileSync } from "node:child_process";
import { ALLOWED_EDIT_PATHS, BACKUP_TAG_PREFIX } from "./config.mjs";

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
}

export function currentHeadSha(repoRoot) {
  return git(repoRoot, ["rev-parse", "HEAD"]).trim();
}

export function createBackupTag(repoRoot, slug) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tagName = `${BACKUP_TAG_PREFIX}${timestamp}-${slug}`;
  git(repoRoot, ["tag", tagName]);
  try {
    git(repoRoot, ["push", "origin", tagName]);
  } catch (error) {
    git(repoRoot, ["tag", "-d", tagName]);
    throw new Error(
      `Failed to push backup tag "${tagName}" to origin -- aborting before making any edit. Underlying error: ${error.message}`,
    );
  }
  return tagName;
}

export function commitAndPush(repoRoot, message, paths) {
  git(repoRoot, ["add", "--", ...paths]);
  git(repoRoot, ["commit", "-m", message]);
  const sha = currentHeadSha(repoRoot);
  try {
    git(repoRoot, ["push", "origin", "HEAD"]);
    return { pushed: true, sha };
  } catch {
    return { pushed: false, sha };
  }
}

export function listBackupTags(repoRoot) {
  const output = git(repoRoot, [
    "tag",
    "--list",
    `${BACKUP_TAG_PREFIX}*`,
    "--sort=-creatordate",
  ]);
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function revertConfigToTag(repoRoot, tagName) {
  git(repoRoot, ["checkout", tagName, "--", ...ALLOWED_EDIT_PATHS]);
  git(repoRoot, ["add", "--", ...ALLOWED_EDIT_PATHS]);
  git(repoRoot, ["commit", "-m", `rollback: restore config to ${tagName}`]);
  return { sha: currentHeadSha(repoRoot) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/git-helpers.test.mjs`
Expected: PASS, 3/3 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/git-helpers.mjs tools/edit-firmware/src/__tests__/git-helpers.test.mjs
git commit -m "feat(edit-firmware): add non-destructive git backup/commit/rollback helpers"
```

---

### Task 7: LLM backend interface and orchestration (fake-backend tested)

**Files:**
- Create: `tools/edit-firmware/src/llm-backend.mjs`
- Create: `tools/edit-firmware/src/__tests__/llm-backend.test.mjs`

**Interfaces:**
- Consumes: `DEFAULT_LLM_BACKEND` from `config.mjs` (Task 1). Deliberately
  does NOT consume anything from Task 8 or Task 9 — see the module
  docstring for why (avoids a forward dependency on files those later
  tasks create).
- Produces: `proposeEdit(request: string, currentFiles: Record<string,string>, options: {backend?: "openai"|"claude", callOpenAI: Function, callClaude: Function}): Promise<{files: Record<string,string>, backend: "openai"|"claude"}>`
  — Task 11 (`edit-firmware.mjs`) calls this by exact name, passing the
  real `callOpenAI`/`callClaude` it imports from Task 8's and Task 9's
  modules. Tests in this task pass fakes for both.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/llm-backend.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeEdit } from "../llm-backend.mjs";

const CURRENT_FILES = {
  "config/eyelash_corne.keymap": "/ { v = <1>; };\n",
  "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=y\n",
};

test("proposeEdit calls the OpenAI backend by default and returns its result", async () => {
  let receivedRequest = null;
  const fakeOpenAI = async (request, files) => {
    receivedRequest = { request, files };
    return { "config/eyelash_corne.keymap": "/ { v = <2>; };\n" };
  };
  const fakeClaude = async () => {
    throw new Error("should not be called");
  };

  const result = await proposeEdit("bump v to 2", CURRENT_FILES, {
    callOpenAI: fakeOpenAI,
    callClaude: fakeClaude,
  });

  assert.equal(result.backend, "openai");
  assert.deepEqual(result.files, { "config/eyelash_corne.keymap": "/ { v = <2>; };\n" });
  assert.equal(receivedRequest.request, "bump v to 2");
  assert.deepEqual(receivedRequest.files, CURRENT_FILES);
});

test("proposeEdit falls back to claude when the OpenAI call throws", async () => {
  const fakeOpenAI = async () => {
    throw new Error("no API key configured");
  };
  const fakeClaude = async () => ({
    "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=n\n",
  });

  const result = await proposeEdit("disable sleep", CURRENT_FILES, {
    callOpenAI: fakeOpenAI,
    callClaude: fakeClaude,
  });

  assert.equal(result.backend, "claude");
  assert.deepEqual(result.files, { "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=n\n" });
});

test("proposeEdit uses claude directly when --backend claude is requested, never calling OpenAI", async () => {
  const fakeOpenAI = async () => {
    throw new Error("should not be called");
  };
  const fakeClaude = async () => ({ "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=n\n" });

  const result = await proposeEdit("disable sleep", CURRENT_FILES, {
    backend: "claude",
    callOpenAI: fakeOpenAI,
    callClaude: fakeClaude,
  });

  assert.equal(result.backend, "claude");
});

test("proposeEdit throws a clear error when both backends fail", async () => {
  const fakeOpenAI = async () => {
    throw new Error("openai down");
  };
  const fakeClaude = async () => {
    throw new Error("claude down");
  };

  await assert.rejects(
    () => proposeEdit("anything", CURRENT_FILES, { callOpenAI: fakeOpenAI, callClaude: fakeClaude }),
    /openai down.*claude down|claude down.*openai down/s,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/__tests__/llm-backend.test.mjs`
Expected: FAIL — `Cannot find module '../llm-backend.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/llm-backend.mjs`**

```javascript
/**
 * Backend-agnostic orchestration for proposing a firmware config edit.
 * This module has no knowledge of how OpenAI or Claude are actually
 * called -- callOpenAI/callClaude are required parameters, always
 * supplied by the caller (edit-firmware.mjs passes the real
 * implementations from openai-backend.mjs/claude-backend.mjs; tests pass
 * fakes). That keeps this file fully unit-testable without spending API
 * credit or requiring Claude Code to be installed, and avoids this file
 * depending on two files (openai-backend.mjs, claude-backend.mjs) that
 * are implemented in later tasks.
 */
import { DEFAULT_LLM_BACKEND } from "./config.mjs";

export async function proposeEdit(request, currentFiles, options = {}) {
  const backend = options.backend ?? DEFAULT_LLM_BACKEND;
  const { callOpenAI, callClaude } = options;
  if (typeof callOpenAI !== "function" || typeof callClaude !== "function") {
    throw new Error("proposeEdit requires both options.callOpenAI and options.callClaude functions.");
  }

  if (backend === "claude") {
    const files = await callClaude(request, currentFiles);
    return { files, backend: "claude" };
  }

  try {
    const files = await callOpenAI(request, currentFiles);
    return { files, backend: "openai" };
  } catch (openaiError) {
    console.error(`OpenAI backend failed (${openaiError.message}); falling back to claude -p.`);
    try {
      const files = await callClaude(request, currentFiles);
      return { files, backend: "claude" };
    } catch (claudeError) {
      throw new Error(
        `Both LLM backends failed. OpenAI: ${openaiError.message}. Claude: ${claudeError.message}.`,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/llm-backend.test.mjs`
Expected: PASS, 4/4 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/llm-backend.mjs tools/edit-firmware/src/__tests__/llm-backend.test.mjs
git commit -m "feat(edit-firmware): add backend-agnostic LLM edit orchestration with fallback"
```

---

### Task 8: Real OpenAI backend (manually verified, not unit tested)

**Files:**
- Create: `tools/edit-firmware/src/openai-backend.mjs`

**Interfaces:**
- Consumes: `ALLOWED_EDIT_PATHS` from `config.mjs` (Task 1).
- Produces: `callOpenAI(request: string, currentFiles: Record<string,string>): Promise<Record<string,string>>`
  — imported by `llm-backend.mjs` (Task 7) as its default OpenAI implementation.

This task has no automated test, by design (see Global Constraints) — it
would spend real OpenAI API credit on every test run. It is verified
manually in Task 13's final acceptance run instead.

- [ ] **Step 1: Write `tools/edit-firmware/src/openai-backend.mjs`**

```javascript
/**
 * Real OpenAI backend. Uses the Responses API (api.openai.com/v1/responses)
 * with a JSON-schema structured output so the model's reply is guaranteed
 * to parse -- no free-text extraction. Requires OPENAI_API_KEY in the
 * environment; never logs the key, never writes it to a file.
 *
 * The model name below (DEFAULT_MODEL) is a fast-moving target external to
 * this codebase. If this backend starts failing with a "model not found"
 * style error, check https://platform.openai.com/docs/models for the
 * current recommended general-purpose model and update the constant --
 * this is the one place that name is declared.
 */
import { ALLOWED_EDIT_PATHS } from "./config.mjs";

const DEFAULT_MODEL = "gpt-5.6";
const RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    files: {
      type: "object",
      description:
        "Map of relative file path to that file's COMPLETE new content. Only include a key for a file that actually needs to change.",
      additionalProperties: { type: "string" },
    },
  },
  required: ["files"],
  additionalProperties: false,
};

function systemPrompt() {
  return [
    "You edit exactly two ZMK firmware configuration files for a hardened, security-reviewed personal keyboard build.",
    `You may propose new content ONLY for these paths: ${ALLOWED_EDIT_PATHS.join(", ")}.`,
    "Never propose a change to any other path, including boards/, build.yaml, or config/west.yml -- those are permanently out of scope regardless of what is asked.",
    "For every file you change, return its COMPLETE new content, not a diff or a partial excerpt.",
    "Only include a key in `files` for a file that actually needs to change; leave the other one out entirely if it doesn't.",
    "Preserve everything in each file you are not deliberately changing -- comments, formatting, and unrelated settings.",
  ].join(" ");
}

export async function callOpenAI(request, currentFiles) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set in the environment.");
  }

  const userPrompt = [
    `Requested change: ${request}`,
    "",
    "Current file contents:",
    ...Object.entries(currentFiles).map(
      ([relativePath, content]) => `--- ${relativePath} ---\n${content}`,
    ),
  ].join("\n");

  const response = await fetch(RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      input: [
        { role: "system", content: systemPrompt() },
        { role: "user", content: userPrompt },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "firmware_edit",
          schema: RESPONSE_SCHEMA,
          strict: true,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API request failed (${response.status}): ${body}`);
  }

  const payload = await response.json();
  const outputText = payload.output?.[0]?.content?.[0]?.text;
  if (!outputText) {
    throw new Error("OpenAI API response did not include the expected output text.");
  }

  const parsed = JSON.parse(outputText);
  return parsed.files;
}
```

- [ ] **Step 2: Manually verify (do not skip, do not automate)**

With `OPENAI_API_KEY` exported in the shell, run a one-off script from
`tools/edit-firmware/`:

```bash
node -e '
import("./src/openai-backend.mjs").then(async ({ callOpenAI }) => {
  const result = await callOpenAI(
    "add a comment at the top of the conf file saying it is test-verified",
    { "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=y\n" },
  );
  console.log(JSON.stringify(result, null, 2));
});
'
```

Confirm: the process exits without throwing, the printed JSON has exactly
one key, `config/eyelash_corne.conf`, and its value is plausible complete
file content (not a diff, not truncated, not touching any other path). If
the request fails with a "model not found"-shaped error, check
`https://platform.openai.com/docs/models`, update `DEFAULT_MODEL`, and
re-run this verification before considering this task done.

- [ ] **Step 3: Commit**

```bash
git add tools/edit-firmware/src/openai-backend.mjs
git commit -m "feat(edit-firmware): add real OpenAI backend (manually verified)"
```

---

### Task 9: Real Claude Code fallback backend (manually verified, not unit tested)

**Files:**
- Create: `tools/edit-firmware/src/claude-backend.mjs`

**Interfaces:**
- Consumes: `ALLOWED_EDIT_PATHS` from `config.mjs` (Task 1).
- Produces: `callClaude(request: string, currentFiles: Record<string,string>): Promise<Record<string,string>>`
  — imported by `llm-backend.mjs` (Task 7) as its fallback implementation.

This task has no automated test, by design — it would require Claude Code
to be installed and would make a real call on every test run. It is
verified manually in Task 13's final acceptance run instead.

- [ ] **Step 1: Write `tools/edit-firmware/src/claude-backend.mjs`**

```javascript
/**
 * Fallback LLM backend: shells out to the Claude Code CLI in non-
 * interactive mode. Used automatically when OPENAI_API_KEY is unset or
 * the OpenAI call fails, or explicitly via --backend claude. Requires no
 * API key -- it uses whatever Claude Code auth is already configured on
 * this machine.
 *
 * `claude -p ... --output-format json` is a documented, stable Claude
 * Code CLI scripting feature. If the installed CLI version has changed
 * this flag's exact shape, run `claude --help` locally to confirm before
 * changing this file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ALLOWED_EDIT_PATHS } from "./config.mjs";

const execFileAsync = promisify(execFile);

function buildPrompt(request, currentFiles) {
  const fileBlocks = Object.entries(currentFiles)
    .map(([relativePath, content]) => `--- ${relativePath} ---\n${content}`)
    .join("\n");

  return [
    `You edit exactly two ZMK firmware configuration files for a hardened, security-reviewed personal keyboard build.`,
    `You may propose new content ONLY for these paths: ${ALLOWED_EDIT_PATHS.join(", ")}. Never propose a change to boards/, build.yaml, or config/west.yml.`,
    `Requested change: ${request}`,
    "",
    "Current file contents:",
    fileBlocks,
    "",
    'Respond with ONLY a JSON object of the exact shape {"files": {"<relative path>": "<complete new file content>"}} -- one key per file that actually needs to change, complete content (never a diff or excerpt), no other text before or after the JSON.',
  ].join("\n");
}

export async function callClaude(request, currentFiles) {
  const prompt = buildPrompt(request, currentFiles);
  const { stdout } = await execFileAsync(
    "claude",
    ["-p", prompt, "--output-format", "json"],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const outer = JSON.parse(stdout);
  if (outer.subtype && outer.subtype !== "success") {
    throw new Error(`claude -p did not succeed: ${outer.subtype}`);
  }
  const resultText = outer.result;
  if (!resultText) {
    throw new Error("claude -p response did not include a result field.");
  }

  const parsed = JSON.parse(resultText);
  return parsed.files;
}
```

- [ ] **Step 2: Manually verify (do not skip, do not automate)**

With Claude Code installed and authenticated on this machine, run from
`tools/edit-firmware/`:

```bash
node -e '
import("./src/claude-backend.mjs").then(async ({ callClaude }) => {
  const result = await callClaude(
    "add a comment at the top of the conf file saying it is test-verified",
    { "config/eyelash_corne.conf": "CONFIG_ZMK_SLEEP=y\n" },
  );
  console.log(JSON.stringify(result, null, 2));
});
'
```

Confirm the same properties as Task 8's manual verification. If
`claude -p ... --output-format json` fails to parse or the flag has
changed, run `claude --help` and update `buildPrompt`/the `execFileAsync`
arguments accordingly before considering this task done.

- [ ] **Step 3: Commit**

```bash
git add tools/edit-firmware/src/claude-backend.mjs
git commit -m "feat(edit-firmware): add real claude -p fallback backend (manually verified)"
```

---

### Task 10: GitHub Actions build trigger, artifact download, and release publishing

**Files:**
- Create: `tools/edit-firmware/src/github-actions.mjs`
- Create: `tools/edit-firmware/src/__tests__/github-actions.test.mjs`

**Interfaces:**
- Consumes: `BUILD_WORKFLOW_FILE` from `config.mjs` (Task 1);
  `looksLikeUf2`, `sha256File` from `checksum.mjs` (Task 4).
- Produces: `findLatestRunForHeadSha(repoRoot: string, headSha: string, options?: {exec?: Function}): {runId: string, status: string, conclusion: string|null, url: string}|null`,
  `watchRun(repoRoot: string, runId: string, options?: {exec?: Function}): {conclusion: string, url: string}`,
  `downloadRunArtifacts(repoRoot: string, runId: string, destDir: string, options?: {exec?: Function}): string[]`
  (returns downloaded file paths, throws if any fails `looksLikeUf2`),
  `publishRelease(repoRoot: string, tagName: string, releaseDir: string, notes: string, options?: {exec?: Function}): void`
  — Task 11 (`edit-firmware.mjs`) calls all four by exact name. The pure
  argument-building and JSON-parsing logic in each is unit tested with an
  injected fake `exec`; the real `gh` calls are manually verified in Task
  13, per Global Constraints.

- [ ] **Step 1: Write the failing test**

```javascript
// tools/edit-firmware/src/__tests__/github-actions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLatestRunForHeadSha,
  watchRun,
  publishRelease,
} from "../github-actions.mjs";

test("findLatestRunForHeadSha builds the correct gh CLI invocation and parses its JSON", () => {
  let capturedArgs = null;
  const fakeExec = (command, args) => {
    capturedArgs = { command, args };
    return JSON.stringify([
      { databaseId: 111, headSha: "deadbeef", status: "completed", conclusion: "success", url: "https://github.com/x/y/actions/runs/111" },
      { databaseId: 110, headSha: "otherSha", status: "completed", conclusion: "success", url: "https://github.com/x/y/actions/runs/110" },
    ]);
  };

  const result = findLatestRunForHeadSha("/repo", "deadbeef", { exec: fakeExec });

  assert.equal(capturedArgs.command, "gh");
  assert.deepEqual(capturedArgs.args.slice(0, 2), ["run", "list"]);
  assert.deepEqual(result, {
    runId: "111",
    status: "completed",
    conclusion: "success",
    url: "https://github.com/x/y/actions/runs/111",
  });
});

test("findLatestRunForHeadSha returns null when no run matches the sha", () => {
  const fakeExec = () => JSON.stringify([{ databaseId: 1, headSha: "unrelated", status: "completed", conclusion: "success", url: "x" }]);
  assert.equal(findLatestRunForHeadSha("/repo", "deadbeef", { exec: fakeExec }), null);
});

test("watchRun polls gh run view until the run is no longer in_progress/queued", () => {
  const responses = [
    JSON.stringify({ status: "in_progress", conclusion: null, url: "https://x/111" }),
    JSON.stringify({ status: "completed", conclusion: "success", url: "https://x/111" }),
  ];
  let callCount = 0;
  const fakeExec = () => responses[Math.min(callCount++, responses.length - 1)];
  const fakeSleep = () => {}; // synchronous no-op, avoids a real delay in the test

  const result = watchRun("/repo", "111", { exec: fakeExec, sleep: fakeSleep });

  assert.deepEqual(result, { conclusion: "success", url: "https://x/111" });
  assert.equal(callCount, 2);
});

test("publishRelease builds the correct gh release create invocation", () => {
  let capturedArgs = null;
  const fakeExec = (command, args) => {
    capturedArgs = { command, args };
    return "";
  };

  publishRelease("/repo", "backup/2026-01-01-x", "/repo/releases/20260101-abc", "Release notes here", {
    exec: fakeExec,
  });

  assert.equal(capturedArgs.command, "gh");
  assert.deepEqual(capturedArgs.args.slice(0, 2), ["release", "create"]);
  assert.ok(capturedArgs.args.includes("backup/2026-01-01-x"));
  assert.ok(capturedArgs.args.some((arg) => arg.includes("Release notes here")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test src/__tests__/github-actions.test.mjs`
Expected: FAIL — `Cannot find module '../github-actions.mjs'`

- [ ] **Step 3: Write `tools/edit-firmware/src/github-actions.mjs`**

```javascript
/**
 * Wraps the `gh` CLI (already authenticated on this machine) for
 * triggering/watching the existing build.yml workflow and publishing a
 * GitHub Release. Every function accepts an injectable `exec` (and, for
 * watchRun, `sleep`) so the argument-building and response-parsing logic
 * is unit-testable without a real network call -- see Global Constraints
 * for why the real `gh` calls themselves are only manually verified.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { looksLikeUf2 } from "./checksum.mjs";
import { BUILD_WORKFLOW_FILE } from "./config.mjs";

function defaultExec(command, args, options) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function findLatestRunForHeadSha(repoRoot, headSha, { exec = defaultExec } = {}) {
  const output = exec("gh", [
    "run",
    "list",
    "--workflow",
    BUILD_WORKFLOW_FILE,
    "--json",
    "databaseId,headSha,status,conclusion,url",
    "--limit",
    "20",
  ], { cwd: repoRoot });

  const runs = JSON.parse(output);
  const match = runs.find((run) => run.headSha === headSha);
  if (!match) return null;
  return {
    runId: String(match.databaseId),
    status: match.status,
    conclusion: match.conclusion,
    url: match.url,
  };
}

export async function watchRun(repoRoot, runId, { exec = defaultExec, sleep = defaultSleep } = {}) {
  const IN_PROGRESS_STATUSES = new Set(["queued", "in_progress", "requested", "waiting"]);
  for (;;) {
    const output = exec("gh", ["run", "view", runId, "--json", "status,conclusion,url"], {
      cwd: repoRoot,
    });
    const info = JSON.parse(output);
    if (!IN_PROGRESS_STATUSES.has(info.status)) {
      return { conclusion: info.conclusion, url: info.url };
    }
    await sleep(10_000);
  }
}

export function downloadRunArtifacts(repoRoot, runId, destDir, { exec = defaultExec } = {}) {
  exec("gh", ["run", "download", runId, "--dir", destDir], { cwd: repoRoot });
  const downloaded = [];
  for (const entry of readdirSync(destDir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".uf2")) continue;
    const filePath = path.join(entry.path ?? destDir, entry.name);
    if (!looksLikeUf2(filePath)) {
      throw new Error(`Downloaded artifact "${filePath}" does not look like a valid UF2 image.`);
    }
    downloaded.push(filePath);
  }
  if (downloaded.length === 0) {
    throw new Error(`No .uf2 artifacts found in the downloaded run ${runId}.`);
  }
  return downloaded;
}

export function publishRelease(repoRoot, tagName, releaseDir, notes, { exec = defaultExec } = {}) {
  const assetPaths = readdirSync(releaseDir).map((name) => path.join(releaseDir, name));
  exec(
    "gh",
    ["release", "create", tagName, ...assetPaths, "--title", tagName, "--notes", notes],
    { cwd: repoRoot },
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test src/__tests__/github-actions.test.mjs`
Expected: PASS, 4/4 tests

- [ ] **Step 5: Commit**

```bash
git add tools/edit-firmware/src/github-actions.mjs tools/edit-firmware/src/__tests__/github-actions.test.mjs
git commit -m "feat(edit-firmware): add gh CLI build-watch/artifact-download/release-publish wrappers"
```

---

### Task 11: Entry point — `edit-firmware.mjs`

**Files:**
- Create: `tools/edit-firmware/src/edit-firmware.mjs`

**Interfaces:**
- Consumes: everything produced by Tasks 1–10, by the exact names listed
  in their Interfaces sections.
- Produces: a runnable CLI entry point; no other module imports from this
  one.

This task has no automated test — it is the interactive orchestration
script itself (reads a real confirmation from the terminal, calls real
git/gh commands). It is exercised by Task 13's final acceptance run.

- [ ] **Step 1: Write `tools/edit-firmware/src/edit-firmware.mjs`**

```javascript
#!/usr/bin/env node
/**
 * Entry point: node src/edit-firmware.mjs "<plain-language request>" [--backend openai|claude]
 *
 * Orchestrates the full guarded flow described in
 * docs/superpowers/specs/2026-08-05-guarded-firmware-edit-tool-design.md:
 * propose -> validate -> confirm -> backup -> commit/push -> build -> release.
 * Nothing survives past the validate step without an explicit "y" from
 * the person running this.
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { execFileSync } from "node:child_process";
import {
  ALLOWED_EDIT_PATHS,
  RELEASES_DIR,
  RELEASE_RETENTION_COUNT,
  LOCK_FILE_PATH,
} from "./config.mjs";
import { validateProposedFiles, stageFiles, diffStaged, discardStaged } from "./apply-patch.mjs";
import { proposeEdit } from "./llm-backend.mjs";
import { callOpenAI } from "./openai-backend.mjs";
import { callClaude } from "./claude-backend.mjs";
import { createBackupTag, commitAndPush } from "./git-helpers.mjs";
import {
  findLatestRunForHeadSha,
  watchRun,
  downloadRunArtifacts,
  publishRelease,
} from "./github-actions.mjs";
import { stageRelease, pruneOldReleases } from "./release-store.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function slugify(request) {
  return request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

async function confirm(promptText) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(promptText);
  rl.close();
  return answer.trim().toLowerCase() === "y";
}

async function main() {
  const args = process.argv.slice(2);
  const backendFlagIndex = args.indexOf("--backend");
  const backend = backendFlagIndex >= 0 ? args[backendFlagIndex + 1] : undefined;
  const request = (backendFlagIndex >= 0 ? args.slice(0, backendFlagIndex) : args).join(" ").trim();

  if (!request) {
    console.error('Usage: node src/edit-firmware.mjs "<plain-language request>" [--backend openai|claude]');
    process.exitCode = 1;
    return;
  }

  const root = repoRoot();
  const lockPath = path.join(root, LOCK_FILE_PATH);
  if (existsSync(lockPath)) {
    console.error(`Another edit-firmware run appears to be in progress (${lockPath} exists). If you're sure it isn't, delete that file and retry.`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(lockPath, String(process.pid), "utf8");

  try {
    const currentFiles = Object.fromEntries(
      ALLOWED_EDIT_PATHS.map((relativePath) => [
        relativePath,
        readFileSync(path.join(root, relativePath), "utf8"),
      ]),
    );

    console.log(`Asking the LLM backend to propose a change for: "${request}"`);
    const proposal = await proposeEdit(request, currentFiles, { backend, callOpenAI, callClaude });
    console.log(`Backend used: ${proposal.backend}`);

    const validation = validateProposedFiles(proposal.files);
    if (!validation.ok) {
      console.error("Proposed change was rejected:");
      for (const reason of validation.reasons) console.error(`  - ${reason}`);
      process.exitCode = 1;
      return;
    }

    stageFiles(root, proposal.files);
    const changedPaths = Object.keys(proposal.files);
    const diff = diffStaged(root, changedPaths);
    console.log("\nProposed change:\n");
    console.log(diff);

    const approved = await confirm("\nApply this change? [y/N] ");
    if (!approved) {
      discardStaged(root, changedPaths);
      console.log("Discarded. Nothing was written.");
      return;
    }

    const slug = slugify(request);
    console.log("Creating and pushing a backup tag before making any change...");
    const backupTag = createBackupTag(root, slug);
    console.log(`Backup tag pushed: ${backupTag}`);

    const commitResult = commitAndPush(root, `firmware: ${request}`, changedPaths);
    if (!commitResult.pushed) {
      console.error(
        `Change was committed locally (${commitResult.sha}) but the push failed. The backup tag is already safe on origin. Retry "git push" manually, or re-run this tool once network/auth is fixed.`,
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Pushed commit ${commitResult.sha}. This triggers build.yml automatically.`);

    console.log("Waiting for the triggered build to start...");
    let run = null;
    for (let attempt = 0; attempt < 12 && !run; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      run = findLatestRunForHeadSha(root, commitResult.sha);
    }
    if (!run) {
      console.error(`Could not find a triggered workflow run for commit ${commitResult.sha}. Check https://github.com/rpatel2023/zmk-corne-hardened/actions manually.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Watching run: ${run.url}`);
    const finished = await watchRun(root, run.runId);
    if (finished.conclusion !== "success") {
      console.error(`Build finished with conclusion "${finished.conclusion}". Nothing was flashed. See ${finished.url}. Your last good release is untouched.`);
      process.exitCode = 1;
      return;
    }

    console.log("Build succeeded. Downloading artifacts...");
    const downloadDir = mkdtempSync(path.join(tmpdir(), "edit-firmware-artifacts-"));
    const artifactPaths = downloadRunArtifacts(root, run.runId, downloadDir);

    const releaseId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${commitResult.sha.slice(0, 7)}`;
    const releasesDir = path.join(root, RELEASES_DIR);
    const releaseDir = stageRelease(releasesDir, releaseId, artifactPaths);
    pruneOldReleases(releasesDir, RELEASE_RETENTION_COUNT);

    publishRelease(
      root,
      backupTag,
      releaseDir,
      `Firmware built from commit ${commitResult.sha} for request: ${request}\n\nRollback: node tools/edit-firmware/src/rollback.mjs --to ${backupTag}`,
    );

    const manifest = readFileSync(path.join(releaseDir, "SHA256SUMS.txt"), "utf8");
    console.log("\nFirmware ready.\n");
    console.log(`Release folder: ${releaseDir}`);
    console.log(`Checksums:\n${manifest}`);
    console.log("To flash: put each half in bootloader mode in turn, then copy the matching .uf2 file onto the drive that appears. This step is manual -- nothing here touches the keyboard.");
  } finally {
    unlinkSync(lockPath);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Commit**

```bash
git add tools/edit-firmware/src/edit-firmware.mjs
git commit -m "feat(edit-firmware): add the edit-firmware entry point orchestrating the full flow"
```

---

### Task 12: Entry point — `rollback.mjs`

**Files:**
- Create: `tools/edit-firmware/src/rollback.mjs`

**Interfaces:**
- Consumes: `listBackupTags`, `revertConfigToTag` from `git-helpers.mjs`
  (Task 6); `listReleases` from `release-store.mjs` (Task 5);
  `RELEASES_DIR` from `config.mjs` (Task 1).
- Produces: a runnable CLI entry point; no other module imports from this
  one.

- [ ] **Step 1: Write `tools/edit-firmware/src/rollback.mjs`**

```javascript
#!/usr/bin/env node
/**
 * Entry point: node src/rollback.mjs --list
 *             node src/rollback.mjs --to <backup-tag>
 *
 * Independent of edit-firmware.mjs -- does not call any LLM and does not
 * trigger a new build. --to restores the source to a prior tag (as a new
 * commit, never a destructive reset) and points at that backup's already-
 * built release folder, if one exists.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { RELEASES_DIR } from "./config.mjs";
import { listBackupTags, revertConfigToTag } from "./git-helpers.mjs";
import { listReleases } from "./release-store.mjs";

function repoRoot() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

function releaseIdForTag(releases, tagName) {
  // Release folder names are "<timestamp>-<short-sha>"; a backup tag name
  // is "backup/<timestamp>-<slug>". There's no guaranteed direct name
  // match, so this looks for a release created at or after the tag's own
  // timestamp prefix as a best-effort hint, not a strict guarantee.
  const tagTimestamp = tagName.split("/")[1]?.split("-").slice(0, 1)[0];
  return releases.find((releaseId) => tagTimestamp && releaseId.startsWith(tagTimestamp)) ?? null;
}

function main() {
  const args = process.argv.slice(2);
  const root = repoRoot();
  const releasesDir = path.join(root, RELEASES_DIR);

  if (args[0] === "--list") {
    const tags = listBackupTags(root);
    const releases = listReleases(releasesDir);
    if (tags.length === 0) {
      console.log("No backup tags found.");
      return;
    }
    console.log("Backup tags (newest first):\n");
    for (const tag of tags) {
      const matchedRelease = releaseIdForTag(releases, tag);
      console.log(`  ${tag}${matchedRelease ? `  (release: ${matchedRelease})` : "  (no local release folder found)"}`);
    }
    return;
  }

  if (args[0] === "--to" && args[1]) {
    const tagName = args[1];
    const tags = listBackupTags(root);
    if (!tags.includes(tagName)) {
      console.error(`"${tagName}" is not a known backup tag. Run --list to see available tags.`);
      process.exitCode = 1;
      return;
    }
    const result = revertConfigToTag(root, tagName);
    console.log(`Source restored to ${tagName} as new commit ${result.sha}. Push this yourself when ready: git push origin HEAD`);

    const releases = listReleases(releasesDir);
    const matchedRelease = releaseIdForTag(releases, tagName);
    if (matchedRelease) {
      console.log(`A previously built release for around this point exists at: ${path.join(releasesDir, matchedRelease)}`);
      console.log("You can flash that firmware directly without waiting for a new build, if you trust it still matches this source state.");
    } else {
      console.log("No local release folder was found for this backup point. Push the reverted commit and let build.yml produce fresh firmware.");
    }
    return;
  }

  console.error("Usage: node src/rollback.mjs --list\n       node src/rollback.mjs --to <backup-tag>");
  process.exitCode = 1;
}

main();
```

- [ ] **Step 2: Commit**

```bash
git add tools/edit-firmware/src/rollback.mjs
git commit -m "feat(edit-firmware): add the rollback entry point"
```

---

### Task 13: README, and final acceptance run

**Files:**
- Create: `tools/edit-firmware/README.md`

**Interfaces:**
- Consumes: nothing (documentation only).

- [ ] **Step 1: Write `tools/edit-firmware/README.md`**

```markdown
# Guarded Firmware Edit Tool

Turns a plain-language keymap change request into a reviewed, committed,
built, checksummed, and GitHub-Released firmware artifact for this
repository. Design: `docs/superpowers/specs/2026-08-05-guarded-firmware-edit-tool-design.md`.

## Prerequisites

- `git` and the `gh` CLI, authenticated (`gh auth status`).
- Either `OPENAI_API_KEY` in your environment (default backend), or Claude
  Code installed and authenticated (`--backend claude`, or automatic
  fallback if the OpenAI call fails).

## Usage

```bash
cd tools/edit-firmware
node src/edit-firmware.mjs "make the triple-tap on td_esc_nav toggle the numbers layer"
```

You'll see the proposed diff and a `[y/N]` prompt. Nothing is written,
committed, or built until you type `y`.

On success you'll get a release folder with checksummed `.uf2` files and
flashing instructions. **Flashing itself is always manual** — this tool
never touches the physical keyboard.

## What this tool will never touch

`boards/` (hardware definitions), root `build.yaml` (build matrix —
this is where `CONFIG_ZMK_STUDIO_LOCKING` lives), and `config/west.yml`
(the pinned dependency manifest). Only `config/eyelash_corne.keymap` and
`config/eyelash_corne.conf` are ever proposed for change.

## Rollback

```bash
node src/rollback.mjs --list
node src/rollback.mjs --to <backup-tag>
```

Restores the two editable files to a prior backup point as a new commit
(never rewrites history, never force-pushes) and points you at that
backup's already-built firmware if one was retained locally.

## Tests

```bash
npm test
```

Runs the automated suite (pure logic: validation, checksums, release
staging, rollback git mechanics). The real OpenAI/`claude -p` calls and
real `gh` orchestration are intentionally not part of this suite — see
"Manually verified" tasks in the implementation plan for why, and how
they were verified.
```

- [ ] **Step 2: Run the full automated test suite**

Run (from `tools/edit-firmware/`): `npm test`
Expected: PASS, all tests across `config`, `structural-check`,
`apply-patch`, `checksum`, `release-store`, `git-helpers`, `llm-backend`,
and `github-actions` test files.

- [ ] **Step 3: Final acceptance — one deliberate, observed real run**

This is the one step in this plan that touches the real repository, real
`gh` CLI, and (if `OPENAI_API_KEY` is set) a real paid API call. Do this
once, deliberately, watching it happen:

1. From `tools/edit-firmware/`, run:
   `node src/edit-firmware.mjs "add a comment at the very top of eyelash_corne.conf noting this line was added by the guarded firmware edit tool's acceptance test"`
2. Confirm the printed diff touches only `config/eyelash_corne.conf`, adds
   a comment line, and changes nothing else.
3. Type `y`.
4. Confirm a backup tag was pushed (`git ls-remote --tags origin | grep backup/`
   from the repo root should show it).
5. Confirm the commit appears on GitHub and a new `build.yml` run started
   (`gh run list --workflow build.yml --limit 1`).
6. Wait for it to complete. Confirm the tool downloaded artifacts,
   staged a release folder under `tools/edit-firmware/releases/`, and
   published a GitHub Release (`gh release list --limit 1`).
7. Roll it back: `node src/rollback.mjs --to <the backup tag from step 4>`,
   then `git push origin HEAD`. Confirm `config/eyelash_corne.conf` no
   longer has the test comment, and that the earlier "acceptance test"
   commit is still visible in `git log` (proving the rollback was additive,
   not a history rewrite).
8. Do not flash the resulting firmware — this was a documentation-only
   change made solely to exercise the pipeline.

- [ ] **Step 4: Commit**

```bash
git add tools/edit-firmware/README.md
git commit -m "docs(edit-firmware): add usage README"
```

## Self-review notes (from writing this plan)

- **Spec coverage:** every component in the design doc (edit-firmware,
  llm-backend with OpenAI default + claude fallback, apply-patch as the
  safety gate, build-and-release split across `github-actions.mjs` +
  `release-store.mjs`, rollback) has a task. The path-allowlist,
  structural check, confirmation gate, backup-tag-before-edit, non-
  destructive rollback, and 10-release local retention are all
  implemented and tested. The corrected `build.yaml` constraint (found
  during spec self-review) is threaded through Global Constraints, Task
  3's tests, and the README.
- **Placeholder scan:** no TBD/TODO markers; every step has real,
  complete code or a fully-specified manual verification procedure.
- **Type/name consistency:** verified `proposeEdit`, `validateProposedFiles`,
  `stageFiles`, `diffStaged`, `discardStaged`, `createBackupTag`,
  `commitAndPush`, `revertConfigToTag`, `listBackupTags`,
  `stageRelease`/`listReleases`/`pruneOldReleases`,
  `findLatestRunForHeadSha`/`watchRun`/`downloadRunArtifacts`/`publishRelease`,
  `sha256File`/`looksLikeUf2` are spelled identically everywhere declared
  and consumed. This pass caught a real bug, not just a naming mismatch:
  Task 7's `llm-backend.mjs` originally imported
  `openai-backend.mjs`/`claude-backend.mjs` directly, but those aren't
  created until Tasks 8–9, which come after it — Task 7's own test would
  have failed on import. Fixed by making `callOpenAI`/`callClaude`
  required parameters instead of internally-imported defaults (Task 7 no
  longer depends on Tasks 8–9 at all), with Task 11 (`edit-firmware.mjs`,
  which legitimately comes after 8–9) importing the real implementations
  and passing them in. Also removed an unused `sha256File` re-export from
  `github-actions.mjs` (imported but never referenced there — every actual
  consumer imports it from `checksum.mjs` directly).
- **Scope:** one coherent tool, appropriately a single plan (per the
  spec's own scope note — it was already the smaller of the two sub-
  projects identified during brainstorming).
