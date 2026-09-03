declare module "*.woff2" {
  const src: string;
  export default src;
}

declare module "*.woff" {
  const src: string;
  export default src;
}

declare module "*.ttf" {
  const src: string;
  export default src;
}

declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.jpg" {
  const src: string;
  export default src;
}

declare module "*.svg" {
  const content: any;
  export default content;
}

declare module "*.scss" {
  const content: Record<string, string>;
  export default content;
}

declare module "*.css" {
  const content: Record<string, string>;
  export default content;
}

interface ImportMetaEnv {
  MODE?: "development" | "production" | "test";
  NODE_ENV?: "development" | "production" | "test";
  VITE_APP_GIT_SHA?: string;
  VITE_APP_LIBRARY_URL?: string;
  VITE_APP_LIBRARY_BACKEND?: string;
  VITE_APP_DISABLE_PREVENT_UNLOAD?: string;
  VITE_APP_DEBUG_ENABLE_TEXT_CONTAINER_BOUNDING_BOX?: string;
  PROD?: boolean | string;
  DEV?: boolean | string;
  [key: string]: any;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
