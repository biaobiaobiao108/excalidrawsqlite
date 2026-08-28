const pkg = require("./package.json");

const parseEnvValue = (value) => {
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

const parseEnvVariables = async (filepath) => {
  // Package builds must also work in clean CI/Docker checkouts where local
  // developer env files are intentionally not committed. Runtime-specific
  // values are injected by the application build instead.
  const file = Bun.file(filepath);
  const source = (await file.exists()) ? await file.text() : "";
  const envVars = {};

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

module.exports = { parseEnvVariables };
