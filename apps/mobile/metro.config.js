// Metro for a pnpm monorepo. We extend Expo's default config — keeping
// its recommended watchFolders + hierarchical-lookup defaults intact per
// expo-doctor — and only add the workspace root + workspace node_modules
// so symlinked workspace packages still resolve.
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [...(config.watchFolders ?? []), workspaceRoot];
config.resolver.nodeModulesPaths = [
  ...(config.resolver.nodeModulesPaths ?? []),
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

module.exports = config;
