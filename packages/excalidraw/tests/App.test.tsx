import React from "react";
import { vi } from "./vitest-shim";

import { reseed } from "@excalidraw/common";

import { Excalidraw } from "../index";
import * as StaticScene from "../renderer/staticScene";
import { render, queryByTestId, unmountComponent } from "../tests/test-utils";

const renderStaticScene = vi.spyOn(StaticScene, "renderStaticScene");

describe("Test <App/>", () => {
  beforeEach(async () => {
    unmountComponent();
    localStorage.clear();
    renderStaticScene.mockClear();
    reseed(7);
  });

  it("should show error modal when using brave and measureText API is not working", async () => {
    (global.navigator as any).brave = {
      isBrave: {
        name: "isBrave",
      },
    };

    const originalGetContext = global.HTMLCanvasElement.prototype.getContext;
    const originalContext = document
      .createElement("canvas")
      .getContext("2d");
    //@ts-ignore
    try {
      global.HTMLCanvasElement.prototype.getContext = (contextId) => {
        return {
          ...originalContext,
          measureText: () => ({
            width: 0,
          }),
        };
      };

      await render(<Excalidraw />);
      const error = queryByTestId(
        document.querySelector(".excalidraw-modal-container")!,
        "brave-measure-text-error",
      );
      expect(error).toHaveAttribute("data-testid", "brave-measure-text-error");
      expect(error).toHaveTextContent("Aggressively Block Fingerprinting");
    } finally {
      global.HTMLCanvasElement.prototype.getContext = originalGetContext;
      delete (global.navigator as any).brave;
    }
  });
});
