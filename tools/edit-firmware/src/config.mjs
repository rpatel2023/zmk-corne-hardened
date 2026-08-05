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
