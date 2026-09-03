import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.scss";

import ExcalidrawApp from "./App";

window.__EXCALIDRAW_SHA__ =
  import.meta.env?.VITE_APP_GIT_SHA || process.env.VITE_APP_GIT_SHA || "";
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
