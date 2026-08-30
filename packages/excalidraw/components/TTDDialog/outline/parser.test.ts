import { describe, it, expect } from "vitest";

import { parseOutlineToTree } from "./parser";

describe("parseOutlineToTree", () => {
  it("returns null for empty input", () => {
    expect(parseOutlineToTree("")).toBeNull();
    expect(parseOutlineToTree("   \n\n  \t ")).toBeNull();
  });

  it("parses single node", () => {
    const tree = parseOutlineToTree("# Root Topic");
    expect(tree).not.toBeNull();
    expect(tree?.text).toBe("Root Topic");
    expect(tree?.children.length).toBe(0);
  });

  it("parses markdown headings hierarchy", () => {
    const md = `
# Central Topic
## Chapter 1
### Section 1.1
## Chapter 2
`;
    const tree = parseOutlineToTree(md);
    expect(tree).not.toBeNull();
    expect(tree?.text).toBe("Central Topic");
    expect(tree?.children.length).toBe(2);
    expect(tree?.children[0].text).toBe("Chapter 1");
    expect(tree?.children[0].children.length).toBe(1);
    expect(tree?.children[0].children[0].text).toBe("Section 1.1");
    expect(tree?.children[1].text).toBe("Chapter 2");
  });

  it("parses bullet and numbered lists with indentation", () => {
    const md = `
- Main Point
  - Sub point 1
  - Sub point 2
    1. Detail A
    2. Detail B
`;
    const tree = parseOutlineToTree(md);
    expect(tree).not.toBeNull();
    expect(tree?.text).toBe("Main Point");
    expect(tree?.children.length).toBe(2);
    expect(tree?.children[1].children.length).toBe(2);
    expect(tree?.children[1].children[0].text).toBe("Detail A");
  });

  it("cleans bold, italic, and inline code formatting", () => {
    const md = `
# **Bold Title** with \`code\` and *italic*
- Item with __bold__ and ~~strike~~
`;
    const tree = parseOutlineToTree(md);
    expect(tree).not.toBeNull();
    expect(tree?.text).toBe("Bold Title with code and italic");
    expect(tree?.children[0].text).toBe("Item with bold and strike");
  });
});
