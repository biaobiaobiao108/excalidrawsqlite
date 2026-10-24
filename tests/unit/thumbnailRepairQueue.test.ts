import { expect, it } from "bun:test";
import { ThumbnailRepairQueue } from "../../excalidraw-app/data/thumbnailRepairQueue";

it("serializes repairs, releases cancelled jobs and continues after failure", async () => {
  const queue = new ThumbnailRepairQueue();
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const calls: string[] = [];
  queue.schedule(async () => {
    calls.push("active");
    await blocked;
  });
  const cancel = queue.schedule(async () => {
    calls.push("cancelled");
  });
  cancel();
  queue.schedule(async () => {
    calls.push("failed");
    throw new Error("render failed");
  });
  const done = new Promise<void>((resolve) => {
    queue.schedule(async () => {
      calls.push("last");
      resolve();
    });
  });
  expect(calls).toEqual(["active"]);
  finish();
  await done;
  expect(calls).toEqual(["active", "failed", "last"]);
});
