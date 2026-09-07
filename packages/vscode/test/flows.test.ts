import assert from "node:assert/strict";
import test from "node:test";
import { pickOne, pickProjectRoot } from "../src/ui/flows.ts";
import { lastProjectRoot, rememberProjectRoot } from "../src/project.ts";

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    get(key: string) { return data.get(key); },
    update(key: string, value: unknown) { data.set(key, value); return Promise.resolve(); },
  };
}

test("pickOne returns undefined when empty", async () => {
  assert.equal(await pickOne<{ label: string }>([], async () => { throw new Error("not called"); }), undefined);
});

test("pickOne forwards options to quickPick", async () => {
  const options = [{ label: "global" }, { label: "project" }];
  const chosen = await pickOne(options, async (items) => items[1]);
  assert.equal(chosen, options[1]);
});

test("remembered root in current folders skips the pick", async () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/b");
  let picked = false;
  const root = await pickProjectRoot(
    [{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }],
    state,
    async () => { picked = true; return undefined; },
  );
  assert.equal(root, "C:/b");
  assert.equal(picked, false);
});

test("stale remembered root falls back to pick", async () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/gone");
  const folders = [{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }];

  const declined = await pickProjectRoot(folders, state, async () => undefined);
  assert.equal(declined, null);

  const chosen = await pickProjectRoot(folders, state, async () => ({ label: "C:/b", fsPath: "C:/b" }));
  assert.equal(chosen, "C:/b");
  assert.equal(lastProjectRoot(state), "C:/b");
});
