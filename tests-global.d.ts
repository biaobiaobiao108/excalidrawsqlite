import type { assert as ChaiAssert } from "chai";
import type { vi as VitestVi } from "./packages/excalidraw/tests/vitest-shim";

declare global {
  var assert: typeof ChaiAssert;
  var vi: typeof VitestVi;
  var global: typeof globalThis;
}

export {};
