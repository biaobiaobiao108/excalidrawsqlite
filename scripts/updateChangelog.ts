import fs from "node:fs";
import { spawnSync } from "bun";
import pkg from "../packages/excalidraw/package.json";

const excalidrawDir = `${__dirname}/../packages/excalidraw`;
const lastVersion = pkg.version;
const existingChangeLog = fs.readFileSync(
  `${excalidrawDir}/CHANGELOG.md`,
  "utf8",
);

const supportedTypes = ["feat", "fix", "style", "refactor", "perf", "build"];
const headerForType: Record<string, string> = {
  feat: "Features",
  fix: "Fixes",
  style: "Styles",
  refactor: " Refactor",
  perf: "Performance",
  build: "Build",
};

const badCommits: string[] = [];

const runGit = (args: string[]): string => {
  const res = spawnSync(["git", ...args]);
  if (res.exitCode !== 0) {
    throw new Error(`git command failed: git ${args.join(" ")}`);
  }
  return res.stdout.toString();
};

const getCommitHashForLastVersion = (): string => {
  try {
    const stdout = runGit([
      "log",
      "--format=format:%H",
      '--grep="release @excalidraw/excalidraw"',
    ]);
    return stdout.split(/\r?\n/)[0];
  } catch (error) {
    console.error(error);
    return "";
  }
};

const getLibraryCommitsSinceLastRelease = (): Record<string, string[]> => {
  const commitHash = getCommitHashForLastVersion();
  const stdout = runGit([
    "log",
    "--pretty=format:%s",
    `${commitHash}...master`,
  ]);
  const commitsSinceLastRelease = stdout.split("\n");
  const commitList: Record<string, string[]> = {};
  supportedTypes.forEach((type) => {
    commitList[type] = [];
  });

  commitsSinceLastRelease.forEach((commit) => {
    const indexOfColon = commit.indexOf(":");
    const type = commit.slice(0, indexOfColon);
    if (!supportedTypes.includes(type)) {
      return;
    }
    const messageWithoutType = commit.slice(indexOfColon + 1).trim();
    const messageWithCapitalizeFirst =
      messageWithoutType.charAt(0).toUpperCase() + messageWithoutType.slice(1);
    const prMatch = commit.match(/\(#([0-9]*)\)/);
    if (prMatch) {
      const prNumber = prMatch[1];

      // return if the changelog already contains the pr number which would happen for package updates
      if (existingChangeLog.includes(prNumber)) {
        return;
      }
      const prMarkdown = `[#${prNumber}](https://github.com/excalidraw/excalidraw/pull/${prNumber})`;
      const messageWithPRLink = messageWithCapitalizeFirst.replace(
        /\(#[0-9]*\)/,
        prMarkdown,
      );
      commitList[type].push(messageWithPRLink);
    } else {
      badCommits.push(commit);
      commitList[type].push(messageWithCapitalizeFirst);
    }
  });
  console.info("Bad commits:", badCommits);
  return commitList;
};

export const updateChangelog = async (nextVersion: string) => {
  const commitList = getLibraryCommitsSinceLastRelease();
  let changelogForLibrary =
    "## Excalidraw Library\n\n**_This section lists the updates made to the excalidraw library and will not affect the integration._**\n\n";
  supportedTypes.forEach((type) => {
    if (commitList[type].length) {
      changelogForLibrary += `### ${headerForType[type]}\n\n`;
      const commits = commitList[type];
      commits.forEach((commit) => {
        changelogForLibrary += `- ${commit}\n\n`;
      });
    }
  });
  changelogForLibrary += "---\n";
  const lastVersionIndex = existingChangeLog.indexOf(`## ${lastVersion}`);
  let updatedContent =
    existingChangeLog.slice(0, lastVersionIndex) +
    changelogForLibrary +
    existingChangeLog.slice(lastVersionIndex);
  const currentDate = new Date().toISOString().slice(0, 10);
  const newVersion = `## ${nextVersion} (${currentDate})`;
  updatedContent = updatedContent.replace(`## Unreleased`, newVersion);
  fs.writeFileSync(`${excalidrawDir}/CHANGELOG.md`, updatedContent, "utf8");
};

export default updateChangelog;

