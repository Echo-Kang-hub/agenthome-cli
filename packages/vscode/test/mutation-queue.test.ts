import assert from "node:assert/strict";
import test from "node:test";
import { MutationQueue, runMutation } from "../src/ui/mutation-queue.ts";

test("mutations run serially in queue order", async () => {
  const queue = new MutationQueue();
  const order: string[] = [];
  const p1 = queue.run(async () => { order.push("a"); await new Promise((r) => setTimeout(r, 10)); order.push("a2"); });
  const p2 = queue.run(async () => { order.push("b"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["a", "a2", "b"]);
});

test("busy reflects in-flight mutation", async () => {
  const queue = new MutationQueue();
  assert.equal(queue.busy, false);
  const p = queue.run(async () => { await new Promise((r) => setTimeout(r, 5)); });
  assert.equal(queue.busy, true);
  await p;
  assert.equal(queue.busy, false);
});

test("queued follow-up keeps busy during its execution", async () => {
  const queue = new MutationQueue();
  let sawBusy = false;
  const p1 = queue.run(async () => { await new Promise((r) => setTimeout(r, 10)); });
  const p2 = queue.run(async () => { sawBusy = queue.busy; });
  await Promise.all([p1, p2]);
  assert.equal(sawBusy, true);
});

test("runMutation refreshes after a successful mutation", async () => {
  const queue = new MutationQueue();
  let refreshed = false;
  const result = await runMutation(queue, async () => 42, () => { refreshed = true; });
  assert.equal(result, 42);
  assert.equal(refreshed, true, "成功 mutation 后必须 refresh");
  assert.equal(queue.busy, false);
});

test("runMutation refreshes even when the mutation rejects (no stale views)", async () => {
  const queue = new MutationQueue();
  let refreshed = false;
  await assert.rejects(runMutation(queue, async () => { throw new Error("boom"); }, () => { refreshed = true; }), /boom/);
  assert.equal(refreshed, true, "失败 mutation 后也必须 refresh，避免树/Dashboard 滞留旧数据");
  assert.equal(queue.busy, false);
});
