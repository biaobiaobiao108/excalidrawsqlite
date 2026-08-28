#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const versionFile = path.join("build", "version.json");
const indexFile = path.join("build", "index.html");

const versionDate = (date) => date.toISOString().replace(".000", "");

const buildHash = (process.env.BUILD_SHA || process.env.VITE_APP_GIT_SHA || "")
  .trim()
  .slice(0, 7);
const buildDate = (process.env.BUILD_DATE || "").trim();

const commitHash = () => {
  if (buildHash) {
    return buildHash;
  }

  try {
    return require("child_process")
      .execSync("git rev-parse --short HEAD")
      .toString()
      .trim();
  } catch {
    return "local";
  }
};

const commitDate = (hash) => {
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
    const unix = require("child_process")
      .execSync(`git show -s --format=%ct ${hash}`)
      .toString()
      .trim();
    const date = new Date(parseInt(unix) * 1000);
    return versionDate(date);
  } catch {
    return versionDate(new Date());
  }
};

const getFullVersion = () => {
  const hash = commitHash();
  return `${commitDate(hash)}-${hash}`;
};

const data = JSON.stringify(
  {
    version: getFullVersion(),
  },
  undefined,
  2,
);

fs.writeFileSync(versionFile, data);

if (fs.existsSync(indexFile)) {
  const content = fs.readFileSync(indexFile, "utf8");
  const result = content.replace(/{version}/g, getFullVersion());
  fs.writeFileSync(indexFile, result, "utf8");
}
