import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";

import { AnimationController } from "../renderer/animation";

const FIRST_KEY = "animation-test-first";
const SECOND_KEY = "animation-test-second";

describe("AnimationController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.EXCALIDRAW_THROTTLE_RENDER = false;
  });

  afterEach(() => {
    AnimationController.cancel(FIRST_KEY);
    AnimationController.cancel(SECOND_KEY);
    window.EXCALIDRAW_THROTTLE_RENDER = undefined;
    vi.useRealTimers();
  });

  it("starts a new animation after the previous last animation was cancelled", async () => {
    let firstFrames = 0;
    AnimationController.start(FIRST_KEY, () => {
      firstFrames++;
      return { keep: true };
    });

    expect(firstFrames).toBe(1);

    AnimationController.cancel(FIRST_KEY);
    vi.runOnlyPendingTimers();
    await Promise.resolve();

    let secondFrames = 0;
    AnimationController.start(SECOND_KEY, () => {
      secondFrames++;
      return secondFrames === 1 ? { keep: true } : null;
    });

    expect(secondFrames).toBe(1);

    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(secondFrames).toBe(2);
    expect(AnimationController.running(SECOND_KEY)).toBe(false);
  });

  it("cancels a frame scheduled during a tick if no animations remain", async () => {
    let firstFrames = 0;
    let secondFrames = 0;

    AnimationController.start(FIRST_KEY, ({ state }) => {
      if (!state) {
        return { keep: true };
      }

      firstFrames++;

      AnimationController.start(SECOND_KEY, () => {
        secondFrames++;
        return { keep: true };
      });
      AnimationController.cancel(SECOND_KEY);

      return null;
    });

    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(firstFrames).toBe(1);
    expect(secondFrames).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resurrect an animation cancelled during its initial callback", async () => {
    let frames = 0;

    AnimationController.start(FIRST_KEY, () => {
      frames++;
      AnimationController.cancel(FIRST_KEY);
      return { keep: true };
    });

    expect(frames).toBe(1);
    expect(AnimationController.running(FIRST_KEY)).toBe(false);

    vi.runOnlyPendingTimers();
    await Promise.resolve();
    expect(frames).toBe(1);
  });

  it("cleans up the registration when the initial callback throws", async () => {
    expect(() =>
      AnimationController.start(FIRST_KEY, () => {
        throw new Error("initial frame failed");
      }),
    ).toThrow("initial frame failed");

    expect(AnimationController.running(FIRST_KEY)).toBe(false);

    vi.runOnlyPendingTimers();
    await Promise.resolve();
    expect(AnimationController.running(FIRST_KEY)).toBe(false);
  });

  it("preserves a same-key replacement started during the initial callback", async () => {
    let originalFrames = 0;
    let replacementFrames = 0;

    const replacement = ({ state }: { state?: { keep: true } }) => {
      replacementFrames++;
      return state ? null : { keep: true as const };
    };

    AnimationController.start(FIRST_KEY, () => {
      originalFrames++;
      AnimationController.cancel(FIRST_KEY);
      AnimationController.start(FIRST_KEY, replacement);
      return { keep: true };
    });

    expect(originalFrames).toBe(1);
    expect(replacementFrames).toBe(1);
    expect(AnimationController.running(FIRST_KEY)).toBe(true);

    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(originalFrames).toBe(1);
    expect(replacementFrames).toBe(2);
    expect(AnimationController.running(FIRST_KEY)).toBe(false);
  });

  it("does not let a completed callback delete its same-key replacement", async () => {
    // tests for this unwanted case:
    //
    // 1. The original animation’s scheduled callback begins.
    // 2. Before it returns, application code cancels it and starts
    //    a replacement using the same key.
    // 3. The original callback returns null.
    // 4. Previously, tick() then called delete(key), accidentally deleting
    //    the replacement.

    let originalFrames = 0;
    let replacementFrames = 0;

    const replacement = ({ state }: { state?: { keep: true } }) => {
      replacementFrames++;
      return state ? null : { keep: true as const };
    };

    AnimationController.start(FIRST_KEY, ({ state }) => {
      if (!state) {
        return { keep: true };
      }

      originalFrames++;
      AnimationController.cancel(FIRST_KEY);
      AnimationController.start(FIRST_KEY, replacement);
      return null;
    });

    vi.advanceTimersToNextTimer();
    await Promise.resolve();

    expect(originalFrames).toBe(1);
    expect(replacementFrames).toBe(1);
    expect(AnimationController.running(FIRST_KEY)).toBe(true);

    vi.runOnlyPendingTimers();
    await Promise.resolve();

    expect(originalFrames).toBe(1);
    expect(replacementFrames).toBe(2);
    expect(AnimationController.running(FIRST_KEY)).toBe(false);
  });
});
