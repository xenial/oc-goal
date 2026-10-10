import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.execPath, ["--conditions=browser", "--experimental-vm-modules", fileURLToPath(new URL("./helpers/tui-runner.mjs", import.meta.url))], { encoding: "utf8" });
assert.equal(result.status, 0, result.stderr);
const ui = JSON.parse(result.stdout.trim());

test("compiled footer reacts to its initial fetch, live status, clear and theme changes", () => {
  assert.equal(ui.initial, null);
  assert.deepEqual(ui.fetched, { text: "goal:active 100tok", fg: "#888" });
  assert.deepEqual(ui.changed, { text: "goal:paused 110tok", fg: "#888" });
  assert.equal(ui.theme.fg, "#aaa");
  assert.equal(ui.cleared, null);
});

test("compiled footer follows reactive session input and rejects stale fetches", () => {
  assert.equal(ui.afterSwitch, null);
  assert.equal(ui.staleFetch.text, "goal:active 200tok");
  assert.equal(ui.failedRefresh.text, "goal:paused 110tok");
});

test("disabled TUI registers nothing", () => {
  assert.equal(ui.disabled, true);
});
