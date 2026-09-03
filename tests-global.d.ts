import type { assert as ChaiAssert } from "chai";

declare global {
  var assert: typeof ChaiAssert;
  var global: typeof globalThis;
}

export {};
