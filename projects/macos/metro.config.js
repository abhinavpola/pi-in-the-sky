import path from "node:path";

const projectRoot = import.meta.dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

export default {
  projectRoot,
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(workspaceRoot, "node_modules"),
    ],
  },
};
