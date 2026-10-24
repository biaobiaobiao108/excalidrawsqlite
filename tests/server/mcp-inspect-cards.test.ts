import { describe, expect, it } from "bun:test";
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from "@excalidraw/element/types";
import {
  createDrawingBatch,
  drawingElementSchema,
} from "../../server/mcp-drawing";
import { buildDrawingLayout, layoutSchema } from "../../server/mcp-layout";
import {
  createInspectCardResolver,
  createInspectGeometryResolver,
} from "../../server/mcp-inspect-cards";

const card = () =>
  createDrawingBatch(
    buildDrawingLayout(
      layoutSchema.parse({
        cards: [{ id: "card", title: "标题", body: "中文正文" }],
        padding: 20,
      }),
    ).elements,
  ).elements;
const plainScene = () =>
  createDrawingBatch(
    [
      {
        type: "rectangle",
        id: "background",
        x: 0,
        y: 0,
        width: 200,
        height: 200,
        fillStyle: "solid",
        backgroundColor: "white",
        groupIds: ["inner", "outer"],
      },
      {
        type: "text",
        id: "note",
        x: 10,
        y: 10,
        text: "正文",
        groupIds: ["inner", "outer"],
      },
    ].map((spec) => drawingElementSchema.parse(spec)),
  ).elements;

describe("MCP grouped card container resolution", () => {
  it("bounds optional geometry inference and uses the rotated rectangle outline rather than its AABB", () => {
    const elements = plainScene();
    const background = {
      ...elements[0],
      groupIds: [],
      angle: (Math.PI / 4) as ExcalidrawElement["angle"],
    };
    const text = {
      ...elements[1],
      groupIds: [],
      x: 100,
      y: 100,
    } as ExcalidrawTextElement;
    const resolver = createInspectGeometryResolver([background, text]);
    expect(resolver.resolve(text).container?.id).toBe(background.id);
    // This point is inside the rotated AABB but outside the actual diamond-shaped rectangle.
    expect(resolver.resolve({ ...text, x: -30, y: -30 }).reason).toBe(
      "no_container",
    );
    expect(
      createInspectGeometryResolver([background], { maxPairs: 0 }).resolve(text)
        .reason,
    ).toBe("limit");
    expect(
      createInspectGeometryResolver([background], { maxReferences: 0 }).resolve(
        text,
      ).reason,
    ).toBe("limit");
    expect(
      createInspectGeometryResolver([
        background,
        { ...background, id: "shadow", x: 2 },
      ]).resolve(text).reason,
    ).toBe("ambiguous");
    expect(resolver.resolve({ ...text, groupIds: ["owned"] }).reason).toBe(
      "no_container",
    );
    expect(resolver.resolve({ ...text, x: 1500 }).reason).toBe("no_container");
  });
  it("resolves displaced create_layout body by native group and stable part IDs without scene mutation", () => {
    const elements = card().map((element) =>
      element.id === "card:body"
        ? { ...element, x: element.x + 1500 }
        : element,
    );
    const text = elements.find(
      (element) => element.id === "card:body",
    ) as ExcalidrawTextElement;
    const snapshot = structuredClone(elements);
    const resolver = createInspectCardResolver(elements);
    const resolved = resolver.resolve(text);
    expect(resolved.container?.id).toBe("card:background");
    expect(resolved.padding).toBe(20);
    expect(resolved.heuristic).toBe(false);
    expect(resolver.stats.complete).toBe(true);
    expect(elements).toEqual(snapshot);
  });

  it("uses inner groups first and refuses to escape ambiguity into outer containers", () => {
    const elements = plainScene();
    const text = elements[1] as ExcalidrawTextElement;
    const outer = {
      ...elements[0],
      id: "outer-background",
      groupIds: ["outer"],
    };
    expect(
      createInspectCardResolver([...elements, outer]).resolve(text).container
        ?.id,
    ).toBe("background");
    const secondInner = { ...elements[0], id: "second-inner" };
    const ambiguous = createInspectCardResolver([
      ...elements,
      secondInner,
      outer,
    ]);
    expect(ambiguous.resolve(text).reason).toBe("ambiguous");
    expect(ambiguous.stats.skippedAmbiguousContainer).toBe(1);
    expect(ambiguous.stats.complete).toBe(true);
    const outerOnly = { ...text, groupIds: ["empty-inner", "outer"] };
    expect(
      createInspectCardResolver([text, outer]).resolve(outerOnly).container?.id,
    ).toBe("outer-background");
  });

  it("prefers layout background over a grouped shadow but never guesses an ungrouped text container", () => {
    const elements = card();
    const background = elements[0],
      body = elements.find(
        (element) => element.id === "card:body",
      ) as ExcalidrawTextElement;
    const shadow = {
      ...background,
      id: "shadow",
      x: background.x + 4,
      y: background.y + 4,
    };
    expect(
      createInspectCardResolver([...elements, shadow]).resolve(body).container
        ?.id,
    ).toBe(background.id);
    const ungrouped = { ...body, groupIds: [] };
    expect(createInspectCardResolver(elements).resolve(ungrouped).reason).toBe(
      "no_container",
    );
    const generic = plainScene();
    expect(
      createInspectCardResolver(generic).resolve(
        generic[1] as ExcalidrawTextElement,
      ),
    ).toMatchObject({ padding: 0, heuristic: true });
    const transparentLayout = elements.map((element) =>
      element.id === background.id
        ? { ...element, backgroundColor: "transparent" }
        : element,
    );
    expect(
      createInspectCardResolver(transparentLayout).resolve(body).container?.id,
    ).toBe(background.id);
  });

  it("reports bounded indexing and comparisons and skips invalid or invisible backgrounds", () => {
    const elements = plainScene(),
      text = elements[1] as ExcalidrawTextElement;
    const indexLimited = createInspectCardResolver(elements, {
      maxReferences: 1,
    });
    expect(indexLimited.resolve(text).reason).toBe("limit");
    expect(indexLimited.stats.references).toBe(1);
    expect(indexLimited.stats.complete).toBe(false);
    const pairLimited = createInspectCardResolver(elements, { maxPairs: 0 });
    expect(pairLimited.resolve(text).reason).toBe("limit");
    expect(pairLimited.stats.pairs).toBe(0);
    expect(pairLimited.stats.complete).toBe(false);
    for (const background of [
      { ...elements[0], opacity: 0 },
      { ...elements[0], backgroundColor: "#0000" },
    ])
      expect(
        createInspectCardResolver([background, text]).resolve(text).reason,
      ).toBe("no_container");
    expect(
      createInspectCardResolver([{ ...elements[0], width: NaN }, text]).resolve(
        text,
      ).reason,
    ).toBe("invalid");
    const malformed = {
      ...text,
      groupIds: Array(33).fill("inner"),
    } as ExcalidrawElement;
    expect(
      createInspectCardResolver(elements).resolve(
        malformed as ExcalidrawTextElement,
      ).reason,
    ).toBe("limit");
  });
});
