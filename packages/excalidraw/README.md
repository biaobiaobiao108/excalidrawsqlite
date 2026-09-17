# Excalidraw

**Excalidraw** is exported as a React component that you can embed directly in your app.

## Installation

Install the package together with its React peer dependencies.

```bash
npm install react react-dom @excalidraw/excalidraw
# or
bun add react react-dom @excalidraw/excalidraw
```

> **Note**: If you want to try unreleased changes, use `@excalidraw/excalidraw@next`.

## Quick start

The minimum working setup has two easy-to-miss requirements:

1. Import the package CSS:

```ts
import "@excalidraw/excalidraw/index.css";
```

2. Render Excalidraw inside a container with a non-zero height.

```tsx
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

export default function App() {
  return (
    <div style={{ height: "100vh" }}>
      <Excalidraw />
    </div>
  );
}
```

Excalidraw fills `100%` of the width and height of its parent. If the parent has no height, the canvas will not be visible.

## Next.js / SSR frameworks

Excalidraw should be rendered on the client. In SSR frameworks such as Next.js, use a client component and load it dynamically with SSR disabled.

```tsx
// app/components/ExcalidrawClient.tsx
"use client";

import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";

export default function ExcalidrawClient() {
  return (
    <div style={{ height: "100vh" }}>
      <Excalidraw />
    </div>
  );
}
```

```tsx
// app/page.tsx
import dynamic from "next/dynamic";

const ExcalidrawClient = dynamic(
  () => import("./components/ExcalidrawClient"),
  { ssr: false },
);

export default function Page() {
  return <ExcalidrawClient />;
}
```

See the [integration docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration)
for a complete setup.

## LLM / agent tips

If an LLM or coding agent is setting up Excalidraw, these shortcuts usually save more time than re-prompting:

- Start with a plain `<Excalidraw />` in a `100vh` container. Add refs, `initialData`, persistence, or custom UI only after the base embed works.
- If the canvas is blank, check the CSS import and parent height first. Those are the two most common integration failures.
- In Next.js or other SSR frameworks, assume client-only rendering first. Use `"use client"` and `dynamic(..., { ssr: false })` before debugging hydration or `window is not defined` errors.
- If imports or entrypoints are unclear, inspect `node_modules/@excalidraw/excalidraw/package.json`. The installed package exports are the source of truth.
- Do not set `window.EXCALIDRAW_ASSET_PATH` unless you are intentionally self-hosting fonts/assets.

## Migrating to `@excalidraw/excalidraw@0.18.x`

Version `0.18.x` removes the old `types/`-prefixed deep import paths. If you were importing types from `@excalidraw/excalidraw/types/...`, switch to the new type-only subpaths below.

| Old path | New path |
| --- | --- |
| `@excalidraw/excalidraw/types/data/transform.js` | `@excalidraw/excalidraw/element/transform` |
| `@excalidraw/excalidraw/types/data/types.js` | `@excalidraw/excalidraw/data/types` |
| `@excalidraw/excalidraw/types/element/types.js` | `@excalidraw/excalidraw/element/types` |
| `@excalidraw/excalidraw/types/utility-types.js` | `@excalidraw/excalidraw/common/utility-types` |
| `@excalidraw/excalidraw/types/types.js` | `@excalidraw/excalidraw/types` |

Drop the `.js` extension. The new package `exports` map resolves these paths without it.

These deep subpaths are for `import type` only. Runtime imports should come from the package root, plus `@excalidraw/excalidraw/index.css` for styles.

For example:

```ts
import { exportToSvg } from "@excalidraw/excalidraw";
```

## Self-hosting fonts

In this app, Excalifont remains bundled locally as the default drawing font. LXGW WenKai and Source Han Sans are loaded from versioned jsDelivr stylesheets.

For self-hosting the package assets, copy the contents of `node_modules/@excalidraw/excalidraw/dist/prod/fonts` into the path where your app serves static assets, for example `public/`. Then set `window.EXCALIDRAW_ASSET_PATH` to that same path. If the deployment cannot reach the CDN, mirror or replace the LXGW WenKai stylesheet link in the host page:

```html
<script>
  window.EXCALIDRAW_ASSET_PATH = "/";
</script>
```

字体选择器中的「霞鹜文楷」通过应用入口加载版本化的 jsDelivr 样式表 `https://cdn.jsdelivr.net/npm/lxgw-wenkai-webfont@1.1.0/style.css`；该样式表负责注册按 Unicode 范围拆分的 `@font-face`。如果在其他宿主页面中使用这个字体，请添加相同的 `<link rel="stylesheet">`。

字体选择器中的「思源黑体」通过应用入口加载版本化的 jsDelivr 样式表 `https://cdn.jsdelivr.net/npm/cn-fontsource-source-han-sans-sc-vf@1.0.10/font.css`；该样式表负责注册按 Unicode 范围拆分的 `@font-face`，CSS 字体名为 `Source Han Sans SC VF`。

## Demo

See the [integration docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration)
for embedding examples.

## Integration

Read the [integration docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/integration).

## API

Read the [API docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api).

## Contributing

Read the [contributing docs](https://docs.excalidraw.com/docs/@excalidraw/excalidraw/contributing).
