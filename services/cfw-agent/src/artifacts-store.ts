import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";

import { MemoryFS } from "./memory-fs";

const DEFAULT_BRANCH = "main";
const WORKSPACE_DIR = "/workspace";
const GIT_AUTHOR = {
  name: "Pi in the Sky Agent",
  email: "agent@pi-in-the-sky.local",
};

const ExtensionManifestSchema = z.object({
  name: z.string(),
  description: z.string(),
  updatedAt: z.string(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

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
    description: "Personal agent self-authored extensions",
    readOnly: false,
    setDefaultBranch: DEFAULT_BRANCH,
  });
  return artifacts.get(repoName);
}

export async function mutateRepo(
  artifacts: Artifacts,
  repoName: string,
  commitMessage: string,
  mutate: (fs: MemoryFS, dir: string) => Promise<readonly string[]>,
): Promise<{ readonly commit: string }> {
  using repo = await openOrCreateRepo(artifacts, repoName);
  const info = await repo.info();
  const existingLog = await repo.log({ ref: DEFAULT_BRANCH, limit: 1 });
  const token = await repo.createToken("write", 300);
  const password = stripTokenExpiry(token.plaintext);
  const onAuth = () => ({ username: "x", password });
  const fs = new MemoryFS();
  try {
    if (existingLog.length > 0) {
      await git.clone({
        fs,
        http,
        dir: WORKSPACE_DIR,
        url: info.remote,
        ref: DEFAULT_BRANCH,
        singleBranch: true,
        depth: 1,
        onAuth,
      });
    } else {
      await git.init({
        fs,
        dir: WORKSPACE_DIR,
        defaultBranch: DEFAULT_BRANCH,
      });
    }
    const changedPaths = await mutate(fs, WORKSPACE_DIR);
    for (const filepath of changedPaths) {
      const fullPath = `${WORKSPACE_DIR}/${filepath}`;
      try {
        await fs.promises.stat(fullPath);
        await git.add({ fs, dir: WORKSPACE_DIR, filepath });
      } catch {
        await git.remove({ fs, dir: WORKSPACE_DIR, filepath });
      }
    }
    const commit = await git.commit({
      fs,
      dir: WORKSPACE_DIR,
      message: commitMessage,
      author: GIT_AUTHOR,
    });
    await git.push({
      fs,
      http,
      dir: WORKSPACE_DIR,
      url: info.remote,
      ref: DEFAULT_BRANCH,
      onAuth,
    });
    return { commit };
  } finally {
    await repo.revokeToken(token.plaintext).catch(() => false);
  }
}

export async function listSavedExtensions(
  artifacts: Artifacts,
  repoName: string,
): Promise<{
  readonly extensions: readonly ExtensionManifest[];
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
      return { extensions: [], recentCommits: [] };
    }
    throw thrown;
  }
  using handle = repo;
  const commits = await handle.log({ ref: DEFAULT_BRANCH, limit: 10 });
  const head = commits[0];
  if (!head) {
    return { extensions: [], recentCommits: [] };
  }
  const rootEntries = await handle.readTree(head.treeHash);
  const extensionsDir = rootEntries?.find(
    (entry) => entry.name === "extensions" && entry.type === "tree",
  );
  if (!extensionsDir) {
    return {
      extensions: [],
      recentCommits: commits.map((c) => ({
        hash: c.hash,
        message: c.message,
        authoredAt: c.authoredAt,
      })),
    };
  }
  const childDirs = (await handle.readTree(extensionsDir.hash)) ?? [];
  const manifests: ExtensionManifest[] = [];
  for (const child of childDirs) {
    if (child.type !== "tree") {
      continue;
    }
    const blob = await handle.readFile({
      ref: DEFAULT_BRANCH,
      path: `extensions/${child.name}/manifest.json`,
    });
    if (!blob) {
      continue;
    }
    try {
      const parsed = ExtensionManifestSchema.safeParse(
        JSON.parse(await blob.text()),
      );
      if (parsed.success) {
        manifests.push(parsed.data);
      }
    } catch {
      continue;
    }
  }
  return {
    extensions: manifests,
    recentCommits: commits.map((c) => ({
      hash: c.hash,
      message: c.message,
      authoredAt: c.authoredAt,
    })),
  };
}

export async function readSavedExtension(
  artifacts: Artifacts,
  repoName: string,
  name: string,
): Promise<{
  readonly code: string;
  readonly manifest: ExtensionManifest | null;
} | null> {
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
  const codeBlob = await handle.readFile({
    ref: DEFAULT_BRANCH,
    path: `extensions/${name}/index.js`,
  });
  if (!codeBlob) {
    return null;
  }
  const manifestBlob = await handle.readFile({
    ref: DEFAULT_BRANCH,
    path: `extensions/${name}/manifest.json`,
  });
  let manifest: ExtensionManifest | null = null;
  if (manifestBlob) {
    try {
      const parsed = ExtensionManifestSchema.safeParse(
        JSON.parse(await manifestBlob.text()),
      );
      if (parsed.success) {
        manifest = parsed.data;
      }
    } catch {
      manifest = null;
    }
  }
  return {
    code: await codeBlob.text(),
    manifest,
  };
}
