import {
  describe,
  it,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  mock,
  spyOn,
  vi as bunVi,
} from "bun:test";

export {
  describe,
  it,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
};

export type MockInstance<T extends (...args: any[]) => any = any> = any;

export const vi = {
  ...bunVi,
  runOnlyPendingTimersAsync: async () => {
    try {
      bunVi.runOnlyPendingTimers();
    } catch {}
    await new Promise((r) => setTimeout(r, 0));
  },
  advanceTimersToNextTimerAsync: async () => {
    try {
      bunVi.advanceTimersToNextTimer();
    } catch {}
    await new Promise((r) => setTimeout(r, 0));
  },
  mock: (path: string, factory?: any) => {
    if (factory) {
      mock.module(path, factory);
    }
  },
};

export default {
  describe,
  it,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  vi,
};
