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
  assert.match(result.reason, /line 2/i);
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
