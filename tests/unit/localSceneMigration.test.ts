import { describe, expect, it } from "bun:test";

import { getLocalSceneMigrationIdentity } from "../../excalidraw-app/data/localSceneMigration";

describe("legacy scene migration identity", () => {
  it("is stable across callers and time for raw legacy elements", async () => {
    const payload = {
      name: "本地画板",
      elements: [
        { type: "rectangle", x: 1, y: 2, width: 20, height: 10 },
        { id: "duplicate", type: "ellipse", x: 4, y: 5, width: 8, height: 9 },
        { id: "duplicate", type: "diamond", x: 7, y: 8, width: 10, height: 11 },
      ],
      appState: { viewBackgroundColor: "#fff" },
    };
    const first = getLocalSceneMigrationIdentity(payload);
    await Bun.sleep(5);
    const second = getLocalSceneMigrationIdentity(structuredClone(payload));

    expect(second).toEqual(first);
  });

  it("uses a different identity when the migrated content changes", () => {
    const payload = {
      name: "本地画板",
      elements: [{ id: "element-1", type: "rectangle" }],
      appState: {},
    };

    expect(getLocalSceneMigrationIdentity(payload).id).not.toBe(
      getLocalSceneMigrationIdentity({
        ...payload,
        elements: [{ id: "element-2", type: "ellipse" }],
      }).id,
    );
  });
});
