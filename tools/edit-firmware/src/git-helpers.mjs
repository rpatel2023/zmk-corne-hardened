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

// `git diff --cached --quiet` exits 0 when the index matches HEAD (nothing
// staged to commit) and 1 when there is a staged difference. Any other
// exit status means something actually went wrong (not a "clean" outcome),
// so that case is re-thrown rather than silently treated as "no changes."
function hasStagedChanges(repoRoot) {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return false;
  } catch (error) {
    if (error.status === 1) {
      return true;
    }
    throw error;
  }
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
      `Failed to push backup tag "${tagName}" to origin -- aborting before committing this edit. Underlying error: ${error.message}`,
    );
  }
  return tagName;
}

export function commitAndPush(repoRoot, message, paths) {
  git(repoRoot, ["add", "--", ...paths]);
  if (!hasStagedChanges(repoRoot)) {
    // Nothing actually changed for the given paths -- committing here
    // would just throw "nothing to commit, working tree clean". There is
    // also nothing to push, so report success: there is nothing wrong,
    // the requested state (paths committed) already holds. `committed:
    // false` lets callers distinguish this no-op from a real commit, so
    // they don't report a build as "triggered" when nothing was pushed.
    return { pushed: true, committed: false, sha: currentHeadSha(repoRoot) };
  }
  // The pathspec on `commit` (not just on the preceding `add`) is load-
  // bearing: it scopes the commit to exactly these paths' current content,
  // regardless of anything else already sitting in the index (e.g. a change
  // to config/west.yml the caller staged before running this tool). Without
  // it, `git commit` commits the whole index, which would let unrelated,
  // unvalidated content ride along into a pushed commit that triggers a
  // real CI build.
  git(repoRoot, ["commit", "-m", message, "--", ...paths]);
  const sha = currentHeadSha(repoRoot);
  try {
    git(repoRoot, ["push", "origin", "HEAD"]);
    return { pushed: true, committed: true, sha };
  } catch {
    return { pushed: false, committed: true, sha };
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
  if (!hasStagedChanges(repoRoot)) {
    // The editable files already match the tag's content -- e.g. this is
    // a repeat/no-op rollback, or a rollback to the tag the tree is
    // already at. Nothing to commit; resolve cleanly at the current HEAD
    // rather than throwing "nothing to commit, working tree clean".
    return { sha: currentHeadSha(repoRoot) };
  }
  git(repoRoot, ["commit", "-m", `rollback: restore config to ${tagName}`]);
  return { sha: currentHeadSha(repoRoot) };
}
