const dotenv = require("dotenv");
const { existsSync, readFileSync } = require("fs");
const pkg = require("./package.json");
const parseEnvVariables = (filepath) => {
  // Package builds must also work in clean CI/Docker checkouts where local
  // developer env files are intentionally not committed. Runtime-specific
  // values are injected by the application build instead.
  const source = existsSync(filepath) ? readFileSync(filepath) : "";
  const envVars = Object.entries(dotenv.parse(source)).reduce(
    (env, [key, value]) => {
      env[key] = value;
      return env;
    },
    {},
  );

  envVars.PKG_NAME = pkg.name;
  envVars.PKG_VERSION = pkg.version;

  return envVars;
};

module.exports = { parseEnvVariables };
