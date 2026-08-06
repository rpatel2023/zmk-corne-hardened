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

// `git status --porcelain` on the two allowed paths is non-empty if the
// user already has uncommitted edits sitting there. stageFiles() would
// silently overwrite those, and discardStaged()'s `git checkout --` only
// restores to the last *commit* -- so a decline afterward would silently
// destroy the user's own pre-existing, never-committed work. Refusing up
// front is the only safe option; there is no revert target to fall back to.
function hasUncommittedChanges(root, paths) {
  // Piped stdio matches every git invocation in git-helpers.mjs -- without
  // it, execFileSync's default sends the child's stderr straight to this
  // process's stderr, which would leak git's own chatter into this tool's
  // output on any unexpected git error.
  const output = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.trim().length > 0;
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

  // Shared mutable state with the signal handlers below: `staged` becomes
  // true the moment the LLM's proposed content is actually written into the
  // real working tree, and `approved` becomes true only once the person
  // running this has typed "y". Anything that ends the process while
  // staged is true and approved is false -- a thrown error, or Ctrl+C at
  // the confirmation prompt -- must leave the working tree exactly as it
  // was, never sitting mid-way with unapproved content on disk.
  let staged = false;
  let approved = false;
  let changedPaths = [];
  let shuttingDown = false;

  const revertUnapprovedStagedContent = () => {
    if (staged && !approved) {
      try {
        discardStaged(root, changedPaths);
        staged = false;
      } catch (revertError) {
        console.error(`Failed to revert unapproved changes: ${revertError.message}`);
      }
    }
  };

  // Node does not run pending try/finally blocks on SIGINT/SIGTERM unless a
  // handler is registered -- without this, Ctrl+C at the "[y/N]" prompt
  // (the single most natural way to say "no" to something alarming) would
  // terminate the process immediately and skip the finally block below,
  // leaving unapproved LLM content sitting in the real config files.
  const cleanupAndExit = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`\nReceived ${signal}; cleaning up before exit...`);
    revertUnapprovedStagedContent();
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort: a signal-time failure to remove the lock is
        // reported to the operator via the stale-lock message on next run,
        // not swallowed silently, but is not itself fatal here.
        console.error(`Could not remove lock file ${lockPath}; you may need to delete it manually before the next run.`);
      }
    }
    process.exit(130);
  };
  process.on("SIGINT", () => cleanupAndExit("SIGINT"));
  process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));

  writeFileSync(lockPath, String(process.pid), "utf8");

  try {
    if (hasUncommittedChanges(root, ALLOWED_EDIT_PATHS)) {
      console.error(
        `You have uncommitted changes to ${ALLOWED_EDIT_PATHS.join(" or ")} already -- commit or stash them first, then re-run this tool.`,
      );
      process.exitCode = 1;
      return;
    }

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

    // `staged`/`changedPaths` are set *before* calling stageFiles, not
    // after it returns. stageFiles writes each proposed path with a
    // separate writeFileSync in a loop -- if a later path's write throws
    // (a file lock from an editor/AV scanner, disk full, ...), an earlier
    // path may already have unapproved content sitting on disk while
    // stageFiles itself never returns. Setting these flags first means the
    // finally block's revert still fires and covers every proposed path,
    // including one whose write never actually happened -- discardStaged's
    // `git checkout --` tolerates a path with no modification.
    changedPaths = Object.keys(proposal.files);
    staged = true;
    stageFiles(root, proposal.files);
    const diff = diffStaged(root, changedPaths);
    console.log("\nProposed change:\n");
    console.log(diff);

    console.log(
      "\nAnswering y will: push a backup tag, commit and push this change, trigger a firmware build, and (if it succeeds) publish a GitHub Release.",
    );
    let userSaidYes;
    try {
      userSaidYes = await confirm("Apply this change? [y/N] ");
    } catch (error) {
      // readline's raw-mode Ctrl+C handling (confirmed against this Node
      // version's lib/internal/readline/interface.js) checks
      // listenerCount('SIGINT') on the *Interface* object created in
      // confirm(), not on `process` -- since nothing listens for 'SIGINT'
      // on that interface, Ctrl+C here closes the interface itself and
      // rejects the pending question() with an AbortError, without ever
      // raising a process-level SIGINT (raw mode suppresses the terminal's
      // own signal generation, so the SIGINT handlers registered above
      // never see this interaction at all). Treat it exactly like "N".
      if (error?.code === "ABORT_ERR" || error?.name === "AbortError") {
        userSaidYes = false;
      } else {
        throw error;
      }
    }
    if (!userSaidYes) {
      revertUnapprovedStagedContent();
      if (staged) {
        // The revert itself failed (already logged above) -- do not claim
        // "nothing was written" when the proposed content is still sitting
        // in the working tree.
        console.error(`The change is still staged in the working tree because reverting it failed. Manually run: git checkout -- ${changedPaths.join(" ")}`);
        process.exitCode = 1;
      } else {
        console.log("Discarded. Nothing was written.");
      }
      return;
    }
    approved = true;

    const slug = slugify(request);
    console.log("Creating and pushing a backup tag before committing this change...");
    let backupTag;
    try {
      backupTag = createBackupTag(root, slug);
    } catch (backupError) {
      // No commit exists yet -- the working tree only has the
      // staged-but-uncommitted proposed content. Revert it so nothing is
      // left half-applied when no backup exists to recover from.
      approved = false;
      revertUnapprovedStagedContent();
      if (staged) {
        // The revert itself failed (already logged by
        // revertUnapprovedStagedContent above) -- do not claim the working
        // tree was reverted when it wasn't.
        console.error(
          `${backupError.message} Additionally, reverting the working tree failed -- the change is still staged. Manually run: git checkout -- ${changedPaths.join(" ")}`,
        );
      } else {
        console.error(
          `${backupError.message} The working tree has been reverted -- no edit was committed.`,
        );
      }
      process.exitCode = 1;
      return;
    }
    console.log(`Backup tag pushed: ${backupTag}`);

    const commitResult = commitAndPush(root, `firmware: ${request}`, changedPaths);
    if (!commitResult.pushed) {
      console.error(
        `Change was committed locally (${commitResult.sha}) but the push failed. The backup tag is already safe on origin. Retry "git push" manually, or re-run this tool once network/auth is fixed.`,
      );
      process.exitCode = 1;
      return;
    }
    if (!commitResult.committed) {
      console.log("Nothing changed -- the proposed content matched what's already there. No commit, no build.");
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
    try {
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
    } catch (postBuildError) {
      console.error(
        `The build succeeded but something went wrong staging the release: ${postBuildError.message}\n` +
          `The firmware exists in CI -- download it manually from ${run.url}, or re-run this tool once the issue is fixed.`,
      );
      process.exitCode = 1;
      return;
    }
  } finally {
    revertUnapprovedStagedContent();
    unlinkSync(lockPath);
  }
}

main().catch((error) => {
  console.error(error.stack ?? error.message);
  process.exitCode = 1;
});
