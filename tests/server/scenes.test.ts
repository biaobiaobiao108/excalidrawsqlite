import { describe, expect, it } from "bun:test";
import { HttpError } from "../../server/errors";
import { getSceneSummary, parseStoredScene } from "../../server/scenes";

const row = {
  id: "scene_current",
  name: "当前画板",
  elements: '[{"id":"rectangle","type":"rectangle"}]',
  app_state: '{"viewBackgroundColor":"#fff"}',
  revision: 3,
  element_count: 1,
  tags_json: "[]",
};

const expectCorrupt = (operation: () => unknown) => {
  try {
    operation();
    throw new Error("Expected CORRUPT_SCENE");
  } catch (error) {
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 500, code: "CORRUPT_SCENE" });
  }
};

describe("current-schema scene readers", () => {
  it("reads persisted revision and count without parsing scene contents for summaries", () => {
    expect(getSceneSummary({ ...row, elements: "invalid JSON" })).toMatchObject({ revision: 3, element_count: 1 });
    expect(getSceneSummary({ ...row, element_count: 0 })).toMatchObject({ element_count: 0 });
    expect(parseStoredScene(row)).toMatchObject({
      revision: 3,
      elements: [{ id: "rectangle", type: "rectangle" }],
      appState: { viewBackgroundColor: "#fff" },
    });
  });

  it("rejects absent or invalid revisions rather than inventing revision one", () => {
    for (const revision of [undefined, null, 0, -1, 1.5, "3", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expectCorrupt(() => getSceneSummary({ ...row, revision }));
      expectCorrupt(() => parseStoredScene({ ...row, revision }));
    }
  });

  it("rejects absent or invalid stored counts instead of guessing from elements", () => {
    for (const element_count of [undefined, null, -1, 0.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expectCorrupt(() => getSceneSummary({ ...row, element_count }));
    }
  });

  it("rejects missing or malformed content rather than returning an empty board", () => {
    for (const elements of [undefined, null, "", "invalid JSON", "null", "{}", "1"]) {
      expectCorrupt(() => parseStoredScene({ ...row, elements }));
    }
    for (const app_state of [undefined, null, "", "invalid JSON", "null", "[]", "1"]) {
      expectCorrupt(() => parseStoredScene({ ...row, app_state }));
    }
    expect(parseStoredScene({ ...row, elements: "[]", app_state: "{}" })).toMatchObject({ elements: [], appState: {} });
  });
});
