import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "bun";

import updateChangelog from "./updateChangelog";

// skipping utils for now, as it has independent release process
const PACKAGES = [
  "common",
  "fractional-indexing",
  "math",
  "element",
  "excalidraw",
];
const ROOT_DIR = path.resolve(__dirname, "..");
const PACKAGES_DIR = path.resolve(__dirname, "../packages");
const CHANGELOG_PATH = path.resolve(PACKAGES_DIR, "excalidraw/CHANGELOG.md");

/**
 * Returns the arguments for the release script.
 *
 * @returns [tag, version, nonInteractive]
 */
const getArguments = (): [string, string, boolean] => {
  let tag = "test";
  let version = "";
  let nonInteractive = false;

  for (const argument of process.argv.slice(2)) {
    if (/--help/.test(argument)) {
      console.info(`Available arguments:
  --tag=<tag>                                    -> (optional) "test" (default), "next" for auto release, "latest" for stable release
  --version=<version>                            -> (optional) for "next" and "test", (required) for "latest" i.e. "0.19.0"
  --non-interactive                              -> (optional) disables interactive prompts`);

      console.info(`\nUsage examples:
  - bun release                                 -> publishes \`@excalidraw\` packages with "test" tag and "-[hash]" version suffix
  - bun release --tag=test                      -> same as above
  - bun release --tag=next                      -> publishes \`@excalidraw\` packages with "next" tag and version "-[hash]" suffix
  - bun release --tag=next --non-interactive    -> skips interactive prompts (runs on CI/CD), otherwise same as above
  - bun release --tag=latest --version=0.19.0   -> publishes \`@excalidraw\` packages with "latest" tag and version "0.19.0" & prepares changelog for the release`);

      process.exit(0);
    }

    if (/--tag=/.test(argument)) {
      tag = argument.split("=")[1];
    }

    if (/--version=/.test(argument)) {
      version = argument.split("=")[1];
    }

    if (/--non-interactive/.test(argument)) {
      nonInteractive = true;
    }
  }

  if (tag !== "latest" && tag !== "next" && tag !== "test") {
    console.error(`Unsupported tag "${tag}", use "latest", "next" or "test".`);
    process.exit(1);
  }

  if (tag === "latest" && !version) {
    console.error("Pass the version to make the latest stable release!");
    process.exit(1);
  }

  if (!version) {
    // set the next version based on the excalidraw package version + commit hash
    const excalidrawPkgJson = JSON.parse(
      fs.readFileSync(getPackageJsonPath("excalidraw"), "utf8"),
    );
    const excalidrawPackageVersion = excalidrawPkgJson.version;

    const hash = getShortCommitHash();

    if (!excalidrawPackageVersion.includes(hash)) {
      version = `${excalidrawPackageVersion}-${hash}`;
    } else {
      // ensuring idempotency
      version = excalidrawPackageVersion;
    }
  }

  console.info(`Running with tag "${tag}" and version "${version}"...`);

  return [tag, version, nonInteractive];
};

const validatePackageName = (packageName: string) => {
  if (!PACKAGES.includes(packageName)) {
    console.error(`Package "${packageName}" not found!`);
    process.exit(1);
  }
};

const getPackageJsonPath = (packageName: string) => {
  validatePackageName(packageName);
  return path.resolve(PACKAGES_DIR, packageName, "package.json");
};

const runCommand = (args: string[], { cwd, inherit = false }: { cwd?: string; inherit?: boolean } = {}) => {
  const result = spawnSync(args, {
    cwd: cwd ?? ROOT_DIR,
    stdout: inherit ? "inherit" : "pipe",
    stderr: inherit ? "inherit" : "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(`Command failed: ${args.join(" ")}`);
  }

  return result;
};

const getReleaseFilePaths = () => [
  ...PACKAGES.map((packageName) => getPackageJsonPath(packageName)),
  path.resolve(__dirname, "../bun.lock"),
  CHANGELOG_PATH,
];

const restoreReleaseFiles = (originalFiles: Map<string, Buffer>) => {
  for (const [filePath, content] of originalFiles) {
    fs.writeFileSync(filePath, content);
  }
};

const assertCleanWorkingTree = () => {
  const status = new TextDecoder()
    .decode(runCommand(["git", "status", "--porcelain", "--untracked-files=all"]).stdout)
    .trim();

  if (status) {
    throw new Error(
      "Stable release requires a clean working tree. Commit or stash existing changes before running the release script.",
    );
  }
};

const updatePackageJsons = (nextVersion: string) => {
  const packageJsons = new Map<string, string>();

  for (const packageName of PACKAGES) {
    const pkgPath = getPackageJsonPath(packageName);
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));

    pkg.version = nextVersion;

    for (const dependencyGroup of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = pkg[dependencyGroup];
      if (!dependencies) {
        continue;
      }

      for (const dependencyName of PACKAGES) {
        const packageDependency = `@excalidraw/${dependencyName}`;
        if (dependencies[packageDependency]) {
          dependencies[packageDependency] = nextVersion;
        }
      }
    }

    packageJsons.set(packageName, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  // modify once, to avoid inconsistent state
  for (const packageName of PACKAGES) {
    const content = packageJsons.get(packageName);
    if (content) {
      fs.writeFileSync(getPackageJsonPath(packageName), content, "utf-8");
    }
  }
};

const getShortCommitHash = () => {
  return new TextDecoder()
    .decode(runCommand(["git", "rev-parse", "--short", "HEAD"]).stdout)
    .trim();
};

const prepareRelease = async (tag: string, version: string) => {
  const releaseFilePaths = getReleaseFilePaths();
  const originalFiles = new Map(
    releaseFilePaths.map((filePath) => [filePath, fs.readFileSync(filePath)]),
  );

  try {
    if (tag === "latest") {
      await updateChangelog(version);
    }

    updatePackageJsons(version);

    console.info("Regenerating bun.lock for the updated workspace versions...");
    runCommand(["bun", "install", "--lockfile-only"], { inherit: true });

    console.info("Checking the regenerated lockfile...");
    runCommand(["bun", "install", "--frozen-lockfile"], { inherit: true });
  } catch (error) {
    restoreReleaseFiles(originalFiles);

    throw new Error(
      `Could not prepare release ${version}; package manifests, bun.lock, and changelog were restored.`,
      { cause: error },
    );
  }

  return originalFiles;
};

const assertOnlyReleaseFilesAreStaged = () => {
  const stagedFiles = new TextDecoder()
    .decode(runCommand(["git", "diff", "--cached", "--name-only", "-z"]).stdout)
    .split("\0")
    .filter(Boolean)
    .map((filePath) => path.resolve(ROOT_DIR, filePath));
  const allowedFiles = new Set(getReleaseFilePaths());
  const unexpectedFiles = stagedFiles.filter((filePath) => !allowedFiles.has(filePath));

  if (unexpectedFiles.length) {
    throw new Error(
      `Refusing to create a release commit with unrelated staged files: ${unexpectedFiles
        .map((filePath) => path.relative(ROOT_DIR, filePath))
        .join(", ")}`,
    );
  }
};

const askToCommit = async (tag: string, nextVersion: string): Promise<void> => {
  if (tag !== "latest") {
    return;
  }

  const answer = (prompt("Would you like to commit these changes to git? (Y/n): ") || "").toLowerCase();
  if (answer === "y") {
    runCommand(
      [
        "git",
        "add",
        "--",
        ...getReleaseFilePaths().map((filePath) => path.relative(ROOT_DIR, filePath)),
      ],
      { inherit: true },
    );
    assertOnlyReleaseFilesAreStaged();
    runCommand(
      [
        "git",
        "commit",
        "-m",
        `chore: release @excalidraw/excalidraw@${nextVersion} 🎉`,
      ],
      { inherit: true },
    );
  } else {
    console.warn("Skipping commit. Don't forget to commit manually later!");
  }
};

const buildPackages = () => {
  console.info("Removing existing build artifacts...");
  for (const packageName of PACKAGES) {
    const pkgDir = path.resolve(PACKAGES_DIR, packageName);
    fs.rmSync(path.join(pkgDir, "dist"), { recursive: true, force: true });
    fs.rmSync(path.join(pkgDir, "types"), { recursive: true, force: true });
  }

  for (const packageName of PACKAGES) {
    console.info(`Building "@excalidraw/${packageName}"...`);
    runCommand(["bun", "run", "build:esm"], {
      cwd: path.resolve(PACKAGES_DIR, packageName),
      inherit: true,
    });
  }
};

const askToPublish = async (tag: string, version: string): Promise<void> => {
  const answer = (prompt("Would you like to publish these changes to npm? (Y/n): ") || "").toLowerCase();
  if (answer === "y") {
    publishPackages(tag, version);
  } else {
    console.info("Skipping publish.");
  }
};

const publishPackages = (tag: string, version: string) => {
  for (const packageName of PACKAGES) {
    runCommand(["bun", "publish", "--tag", tag], {
      cwd: path.resolve(PACKAGES_DIR, packageName),
      inherit: true,
    });

    console.info(
      `Published "@excalidraw/${packageName}@${tag}" with version "${version}"! 🎉`,
    );
  }
};

/** main */
const [tag, version, nonInteractive] = getArguments();

if (tag === "latest") {
  assertCleanWorkingTree();
}

const originalReleaseFiles = await prepareRelease(tag, version);

try {
  buildPackages();
} catch (error) {
  restoreReleaseFiles(originalReleaseFiles);
  throw new Error(
    `Could not build release ${version}; package manifests, bun.lock, and changelog were restored.`,
    { cause: error },
  );
}

if (nonInteractive) {
  publishPackages(tag, version);
} else {
  await askToCommit(tag, version);
  await askToPublish(tag, version);
}
