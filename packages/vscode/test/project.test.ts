import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_ROOT_STATE_KEY, lastProjectRoot, rememberProjectRoot, rememberedProjectRoot, resolveProjectRoot } from "../src/project.ts";

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    get(key: string) { return data.get(key); },
    update(key: string, value: unknown) { data.set(key, value); return Promise.resolve(); },
  };
}

test("single workspace folder resolves to its fsPath", () => {
  assert.equal(resolveProjectRoot([{ uri: { fsPath: "C:/proj" } }]), "C:/proj");
});

test("no folders returns null", () => {
  assert.equal(resolveProjectRoot([]), null);
});

test("multi-root returns null (caller must pick)", () => {
  assert.equal(resolveProjectRoot([{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }]), null);
});

test("remember/last round-trips through state", () => {
  const state = fakeState();
  assert.equal(lastProjectRoot(state), null);
  rememberProjectRoot(state, "C:/proj");
  assert.equal(lastProjectRoot(state), "C:/proj");
});

test("remembered root returns the folder when memory matches a live folder", () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/b");
  const folders = [{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }];
  assert.equal(rememberedProjectRoot(folders, state), "C:/b");
});

test("remembered root returns null for stale memory not in live folders", () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/gone");
  assert.equal(rememberedProjectRoot([{ uri: { fsPath: "C:/a" } }], state), null);
});

test("remembered root returns null with no memory", () => {
  const state = fakeState();
  assert.equal(rememberedProjectRoot([{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }], state), null);
});

test("state key is stable", () => {
  assert.equal(PROJECT_ROOT_STATE_KEY, "avenic.projectRoot");
});
