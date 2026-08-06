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
