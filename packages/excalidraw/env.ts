import fs from "node:fs";
import path from "node:path";
import pkg from "./package.json";

export const parseEnvValue = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed.replace(/\s+#.*$/, "").trim();
};

export const parseEnvSource = (source: string): Record<string, string> => {
  const envVars: Record<string, string> = {};

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (match) {
      envVars[match[1]] = parseEnvValue(match[2]);
    }
  }

  return envVars;
};

export const loadEnvVariables = (
  projectRoot: string,
  mode: string,
): Record<string, string> => {
  const envVars: Record<string, string> = {};
  const filenames = [
    ".env",
    ".env.local",
    `.env.${mode}`,
    `.env.${mode}.local`,
  ];

  for (const filename of filenames) {
    const filepath = path.join(projectRoot, filename);
    if (fs.existsSync(filepath)) {
      Object.assign(envVars, parseEnvSource(fs.readFileSync(filepath, "utf8")));
    }
  }

  return envVars;
};

export const getClientEnvVariables = (
  projectRoot: string,
  mode: string,
  overrides: Record<string, any> = {},
): Record<string, any> => {
  const processEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("VITE_")),
  );
  const clientEnv = {
    ...loadEnvVariables(projectRoot, mode),
    ...processEnv,
    MODE: mode,
    NODE_ENV: mode,
    DEV: mode === "development",
    PROD: mode === "production",
    PKG_NAME: pkg.name,
    PKG_VERSION: pkg.version,
    ...overrides,
  };

  return Object.fromEntries(
    Object.entries(clientEnv).filter(
      ([key]) =>
        key.startsWith("VITE_") ||
        ["MODE", "NODE_ENV", "DEV", "PROD", "PKG_NAME", "PKG_VERSION"].includes(
          key,
        ),
    ),
  );
};

export const parseEnvVariables = async (
  filepath: string,
): Promise<Record<string, string>> => {
  // Package builds must also work in clean CI/Docker checkouts where local
  // developer env files are intentionally not committed. Runtime-specific
  // values are injected by the application build instead.
  const file = Bun.file(filepath);
  const source = (await file.exists()) ? await file.text() : "";
  const envVars: Record<string, string> = {};

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w]*)\s*=\s*(.*)$/);
    if (match) {
      envVars[match[1]] = parseEnvValue(match[2]);
    }
  }

  envVars.PKG_NAME = pkg.name;
  envVars.PKG_VERSION = pkg.version;

  return envVars;
};

