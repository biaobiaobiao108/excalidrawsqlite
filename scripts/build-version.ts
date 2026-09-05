#!/usr/bin/env bun
import path from "node:path";
import { spawnSync } from "bun";

const versionFile = path.join("build", "version.json");
const indexFile = path.join("build", "index.html");

const versionDate = (date: Date) => date.toISOString().replace(".000", "");

const buildHash = (process.env.BUILD_SHA || process.env.VITE_APP_GIT_SHA || "")
  .trim()
  .slice(0, 7);
const buildDate = (process.env.BUILD_DATE || "").trim();

const commitHash = (): string => {
  if (buildHash) {
    return buildHash;
  }

  try {
    const res = spawnSync(["git", "rev-parse", "--short", "HEAD"]);
    if (res.exitCode === 0) {
      return res.stdout.toString().trim();
    }
    return "local";
  } catch {
    return "local";
  }
};

const commitDate = (hash: string): string => {
  if (buildDate) {
    const date = new Date(buildDate);
    if (!Number.isNaN(date.getTime())) {
      return versionDate(date);
    }
  }

  if (buildHash) {
    return versionDate(new Date());
  }

  try {
    const res = spawnSync(["git", "show", "-s", "--format=%ct", hash]);
    if (res.exitCode === 0) {
      const unix = res.stdout.toString().trim();
      const date = new Date(parseInt(unix, 10) * 1000);
      return versionDate(date);
    }
    return versionDate(new Date());
  } catch {
    return versionDate(new Date());
  }
};

const getFullVersion = (): string => {
  const hash = commitHash();
  return `${commitDate(hash)}-${hash}`;
};

const version = getFullVersion();
const data = JSON.stringify(
  {
    version,
  },
  undefined,
  2,
);

await Bun.write(versionFile, data);

const indexFileHandle = Bun.file(indexFile);
if (await indexFileHandle.exists()) {
  const content = await indexFileHandle.text();
  const result = content.replace(/{version}/g, version);
  await Bun.write(indexFile, result);
}

