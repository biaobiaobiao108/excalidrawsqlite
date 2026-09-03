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

export type MockInstance<T extends (...args: any[]) => any = any> = T & {
  mock: Record<string, unknown>;
};

const spyOn = (object: any, property: string, accessType?: "get" | "set") => {
  if (!accessType) {
    return bunVi.spyOn(object, property);
  }

  let owner = object;
  let descriptor: PropertyDescriptor | undefined;
  while (owner && !descriptor) {
    descriptor = Object.getOwnPropertyDescriptor(owner, property);
    owner = Object.getPrototypeOf(owner);
  }

  if (!descriptor || typeof descriptor[accessType] !== "function") {
    throw new TypeError(`Cannot spy on ${accessType} accessor ${property}`);
  }

  const original = descriptor[accessType];
  const ownDescriptor = Object.getOwnPropertyDescriptor(object, property);
  const spy = bunVi.fn();
  Object.defineProperty(object, property, {
    configurable: true,
    enumerable: descriptor.enumerable,
    get: accessType === "get" ? spy : descriptor.get,
    set: accessType === "set" ? spy : descriptor.set,
  });

  Object.defineProperty(spy, "mockRestore", {
    configurable: true,
    value: () => {
      if (ownDescriptor) {
        Object.defineProperty(object, property, ownDescriptor);
      } else {
        delete object[property];
      }
    },
  });
  spy.mockImplementation(original.bind(object));
  return spy;
};

const runOnlyPendingTimersAsync = async () => {
  try {
    bunVi.runOnlyPendingTimers();
  } catch {}
  await Promise.resolve();
};

const advanceTimersToNextTimerAsync = async () => {
  try {
    bunVi.advanceTimersToNextTimer();
  } catch {}
  await Promise.resolve();
};

Object.assign(bunVi, {
  runOnlyPendingTimersAsync,
  advanceTimersToNextTimerAsync,
});

export const vi = {
  ...bunVi,
  spyOn,
  runOnlyPendingTimersAsync,
  advanceTimersToNextTimerAsync,
  mock: (path: string, factory?: any) => {
    if (!factory) {
      mock.module(path, () => ({}));
      return;
    }

    // Vitest passes an importOriginal helper to async mock factories. Bun's
    // mock.module callback has no such argument, so capture the current module
    // before registering the replacement and expose it through the same shape.
    let original: any;
    try {
      original = require(path);
    } catch {
      original = undefined;
    }

    if (factory.constructor.name === "AsyncFunction") {
      mock.module(path, () => factory(async () => original));
    } else {
      mock.module(path, () => factory());
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
