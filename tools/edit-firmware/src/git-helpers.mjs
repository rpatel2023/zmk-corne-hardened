/**
 * Git operations for the guarded firmware edit tool. Deliberately never
 * uses `git reset --hard` or a force-push anywhere: rollback restores the
 * two editable files to a prior tag's content as a brand-new commit, so
 * history is always additive and nothing already pushed is ever rewritten.
 */
import { execFileSync } from "node:child_process";
import { ALLOWED_EDIT_PATHS, BACKUP_TAG_PREFIX } from "./config.mjs";

function git(repoRoot, args) {
  // execFileSync's documented default sends the child's stderr straight to
  // this process's stderr even though stdout is captured -- that would leak
  // git's own progress/error chatter (e.g. push confirmations, "fatal: ..."
  // on a broken remote) into whatever is running this tool. Pipe all three
  // streams so output is captured, not inherited; on failure it still shows
  // up via error.stderr / error.message for callers that need it.
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
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
