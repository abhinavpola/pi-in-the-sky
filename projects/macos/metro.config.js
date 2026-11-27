import path from "node:path";

import { getDefaultConfig, mergeConfig } from "@react-native/metro-config";

const projectRoot = import.meta.dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

export default mergeConfig(getDefaultConfig(projectRoot), {
  projectRoot,
  watchFolders: [workspaceRoot],
  resolver: {
    unstable_enablePackageExports: true,
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(workspaceRoot, "node_modules"),
    ],
  },
});
