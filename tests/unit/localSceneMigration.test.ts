import { describe, expect, it } from "bun:test";

import { getLocalSceneMigrationIdentity } from "../../excalidraw-app/data/localSceneMigration";

describe("legacy scene migration identity", () => {
  it("is stable for the same migrated payload across callers", () => {
    const payload = {
      name: "本地画板",
      elements: [{ id: "element-1", type: "rectangle" }],
      appState: { viewBackgroundColor: "#fff" },
    };

    expect(getLocalSceneMigrationIdentity(payload)).toEqual(
      getLocalSceneMigrationIdentity(structuredClone(payload)),
    );
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
