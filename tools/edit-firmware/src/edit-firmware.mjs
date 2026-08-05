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
