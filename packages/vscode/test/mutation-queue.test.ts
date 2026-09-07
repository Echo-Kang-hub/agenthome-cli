import assert from "node:assert/strict";
import test from "node:test";
import { MutationQueue } from "../src/ui/mutation-queue.ts";

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
