import fs from "node:fs";
import path from "node:path";

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";

const EXTENSION_ROOT = "extension";
const DEFAULT_BRANCH = "main";
const GIT_AUTHOR = {
  name: "Pi in the Sky Agent",
  email: "agent@pi-in-the-sky.local",
};

const ALLOWED_ROOT_FILES = new Set(["extension.ts", "instructions.md"]);
const ALLOWED_ROOT_DIRS = new Set([
  "tools",
  "channels",
  "connections",
  "skills",
  "schedules",
  "subagents",
  "hooks",
  "lib",
]);
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EXECUTABLE_MODULE_EXT = /\.(?:ts|js|mjs|json)$/;

export function normalizeExtensionPath(rawPath: string): {
  readonly relativePath: string;
  readonly repoPath: string;
} | null {
  const trimmed = rawPath
    .trim()
    .replace(/^\.\//, "")
    .replace(/^extension\//, "");
  if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\\")) {
    return null;
  }
  const segments = trimmed.split("/");
  if (segments.some((seg) => !SEGMENT_PATTERN.test(seg) || seg === "..")) {
    return null;
  }
  const [first, ...rest] = segments;
  if (!first) {
    return null;
  }
  if (rest.length === 0) {
    if (!ALLOWED_ROOT_FILES.has(first)) {
      return null;
    }
  } else if (!ALLOWED_ROOT_DIRS.has(first)) {
    return null;
  }
  return {
    relativePath: trimmed,
    repoPath: `${EXTENSION_ROOT}/${trimmed}`,
  };
}

function stripTokenExpiry(token: string): string {
  return token.split("?expires=")[0] ?? token;
}

function isArtifactsNotFound(thrown: unknown): boolean {
  return (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    thrown.code === "NOT_FOUND"
  );
}

async function openOrCreateRepo(
  artifacts: Artifacts,
  repoName: string,
): Promise<ArtifactsRepo> {
  try {
    return await artifacts.get(repoName);
  } catch (thrown) {
    if (!isArtifactsNotFound(thrown)) {
      throw thrown;
    }
  }
  await artifacts.create(repoName, {
    description: "Personal agent self-authored extension workspace",
    readOnly: false,
    setDefaultBranch: DEFAULT_BRANCH,
  });
  return artifacts.get(repoName);
}

export async function mutateRepo(
  artifacts: Artifacts,
  repoName: string,
  commitMessage: string,
  mutate: (
    fsPromises: typeof fs.promises,
    dir: string,
  ) => Promise<readonly string[]>,
): Promise<{ readonly commit: string }> {
  using repo = await openOrCreateRepo(artifacts, repoName);
  const info = await repo.info();
  const existingLog = await repo.log({ ref: DEFAULT_BRANCH, limit: 1 });
  const token = await repo.createToken("write", 300);
  const password = stripTokenExpiry(token.plaintext);
  const onAuth = () => ({ username: "x", password });
  const workspaceDir = path.posix.join("/tmp", `ext-${crypto.randomUUID()}`);
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  try {
    if (existingLog.length > 0) {
      await git.clone({
        fs,
        http,
        dir: workspaceDir,
        url: info.remote,
        ref: DEFAULT_BRANCH,
        singleBranch: true,
        depth: 1,
        onAuth,
      });
    } else {
      await git.init({
        fs,
        dir: workspaceDir,
        defaultBranch: DEFAULT_BRANCH,
      });
    }
    const changedPaths = await mutate(fs.promises, workspaceDir);
    for (const filepath of changedPaths) {
      const fullPath = path.posix.join(workspaceDir, filepath);
      try {
        await fs.promises.stat(fullPath);
        await git.add({ fs, dir: workspaceDir, filepath });
      } catch {
        await git.remove({ fs, dir: workspaceDir, filepath });
      }
    }
    const commit = await git.commit({
      fs,
      dir: workspaceDir,
      message: commitMessage,
      author: GIT_AUTHOR,
    });
    await git.push({
      fs,
      http,
      dir: workspaceDir,
      url: info.remote,
      ref: DEFAULT_BRANCH,
      onAuth,
    });
    return { commit };
  } finally {
    await fs.promises
      .rm(workspaceDir, { recursive: true, force: true })
      .catch(() => undefined);
    await repo.revokeToken(token.plaintext).catch(() => false);
  }
}

async function walkTreeFiles(
  handle: ArtifactsRepo,
  treeHash: string,
  prefix: string,
  out: string[],
): Promise<void> {
  const entries = (await handle.readTree(treeHash)) ?? [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.type === "tree") {
      await walkTreeFiles(handle, entry.hash, rel, out);
    } else if (entry.type === "blob") {
      out.push(rel);
    }
  }
}

export async function listExtensionFiles(
  artifacts: Artifacts,
  repoName: string,
): Promise<{
  readonly files: readonly string[];
  readonly recentCommits: readonly {
    readonly hash: string;
    readonly message: string;
    readonly authoredAt: number;
  }[];
}> {
  let repo: ArtifactsRepo;
  try {
    repo = await artifacts.get(repoName);
  } catch (thrown) {
    if (isArtifactsNotFound(thrown)) {
      return { files: [], recentCommits: [] };
    }
    throw thrown;
  }
  using handle = repo;
  const commits = await handle.log({ ref: DEFAULT_BRANCH, limit: 10 });
  const recentCommits = commits.map((c) => ({
    hash: c.hash,
    message: c.message,
    authoredAt: c.authoredAt,
  }));
  const head = commits[0];
  if (!head) {
    return { files: [], recentCommits };
  }
  const rootEntries = await handle.readTree(head.treeHash);
  const extDir = rootEntries?.find(
    (entry) => entry.name === EXTENSION_ROOT && entry.type === "tree",
  );
  if (!extDir) {
    return { files: [], recentCommits };
  }
  const files: string[] = [];
  await walkTreeFiles(handle, extDir.hash, "", files);
  files.sort();
  return { files, recentCommits };
}

export async function readExtensionFile(
  artifacts: Artifacts,
  repoName: string,
  repoPath: string,
): Promise<string | null> {
  let repo: ArtifactsRepo;
  try {
    repo = await artifacts.get(repoName);
  } catch (thrown) {
    if (isArtifactsNotFound(thrown)) {
      return null;
    }
    throw thrown;
  }
  using handle = repo;
  const blob = await handle.readFile({
    ref: DEFAULT_BRANCH,
    path: repoPath,
  });
  return blob ? blob.text() : null;
}

export async function readExtensionModules(
  artifacts: Artifacts,
  repoName: string,
): Promise<ReadonlyMap<string, string>> {
  const { files } = await listExtensionFiles(artifacts, repoName);
  const modules = new Map<string, string>();
  if (files.length === 0) {
    return modules;
  }
  let repo: ArtifactsRepo;
  try {
    repo = await artifacts.get(repoName);
  } catch (thrown) {
    if (isArtifactsNotFound(thrown)) {
      return modules;
    }
    throw thrown;
  }
  using handle = repo;
  for (const relativePath of files) {
    if (!EXECUTABLE_MODULE_EXT.test(relativePath)) {
      continue;
    }
    const blob = await handle.readFile({
      ref: DEFAULT_BRANCH,
      path: `${EXTENSION_ROOT}/${relativePath}`,
    });
    if (blob) {
      modules.set(relativePath, await blob.text());
    }
  }
  return modules;
}
