import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str, unknown } from "@earendil-works/pi-schema";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { z } from "zod";

import { jsonToolResult } from "./http-tool";
import { MemoryFS } from "./memory-fs";

const ARTIFACTS_REPO_PREFIX = "agent-extensions";
const DEFAULT_BRANCH = "main";
const EXTENSION_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
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

type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

function isValidExtensionName(name: string): boolean {
  return EXTENSION_NAME_PATTERN.test(name);
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
    description: "Personal agent self-authored extensions",
    readOnly: false,
    setDefaultBranch: DEFAULT_BRANCH,
  });
  return artifacts.get(repoName);
}

async function mutateRepo(
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

async function listSavedExtensions(
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

async function readSavedExtension(
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

async function runInDynamicWorker(
  loader: WorkerLoader,
  code: string,
  input: unknown,
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly output: unknown;
}> {
  const worker = loader.load({
    compatibilityDate: "2026-11-27",
    mainModule: "index.js",
    modules: {
      "index.js": code,
    },
    globalOutbound: null,
    limits: {
      cpuMs: 50,
      subRequests: 0,
    },
  });
  const response = await worker.getEntrypoint().fetch(
    new Request("https://extension.internal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: input ?? null }),
    }),
  );
  const contentType = response.headers.get("Content-Type") ?? "";
  const rawText = await response.text();
  let output: unknown = rawText;
  if (contentType.includes("application/json")) {
    try {
      output = JSON.parse(rawText);
    } catch {
      output = rawText;
    }
  }
  return {
    ok: response.ok,
    status: response.status,
    output,
  };
}

const EmptySchema = obj({});

const SaveExtensionSchema = obj({
  name: str(),
  description: str(),
  code: str(),
  commitMessage: opt(str()),
});

const ReadExtensionSchema = obj({
  name: str(),
});

const RunExtensionSchema = obj({
  name: opt(str()),
  code: opt(str()),
  input: opt(unknown()),
});

const DeleteExtensionSchema = obj({
  name: str(),
  commitMessage: opt(str()),
});

async function loadNamedExtension(
  getArtifacts: () => Artifacts | undefined,
  repoName: string,
  name: string,
): Promise<
  | {
      readonly ok: true;
      readonly code: string;
      readonly manifest: ExtensionManifest | null;
    }
  | { readonly ok: false; readonly error: string }
> {
  const artifacts = getArtifacts();
  if (!artifacts) {
    return { ok: false, error: "ARTIFACTS binding is not configured." };
  }
  if (!isValidExtensionName(name)) {
    return { ok: false, error: "Invalid extension name." };
  }
  const saved = await readSavedExtension(artifacts, repoName, name);
  if (!saved) {
    return { ok: false, error: `Extension "${name}" not found.` };
  }
  return { ok: true, ...saved };
}

export function createExtensionsExtension(
  getArtifacts: () => Artifacts | undefined,
  getLoader: () => WorkerLoader | undefined,
  agentScope: string,
): Extension {
  const cleanScope = agentScope
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
  const repoName = cleanScope
    ? `${ARTIFACTS_REPO_PREFIX}-${cleanScope}`
    : ARTIFACTS_REPO_PREFIX;
  const saveTool: ToolRegistration<typeof SaveExtensionSchema> = {
    name: "extension_save",
    description:
      "Save or update a self-authored JavaScript extension in Cloudflare Artifacts (Git-versioned). Code must be an ES module exporting default { async fetch(request) { ... } }.",
    parameters: SaveExtensionSchema,
    replay: "safe",
    async execute({ name, description, code, commitMessage }) {
      const artifacts = getArtifacts();
      if (!artifacts) {
        return jsonToolResult(
          { error: "ARTIFACTS binding is not configured." },
          true,
        );
      }
      if (!isValidExtensionName(name)) {
        return jsonToolResult(
          {
            error:
              "Invalid extension name. Use 1-64 lowercase letters, digits, hyphens, or underscores.",
          },
          true,
        );
      }
      const manifest: ExtensionManifest = {
        name,
        description: description.trim(),
        updatedAt: new Date().toISOString(),
      };
      const result = await mutateRepo(
        artifacts,
        repoName,
        commitMessage?.trim() || `Save extension ${name}`,
        async (fs, dir) => {
          const codeRel = `extensions/${name}/index.js`;
          const manifestRel = `extensions/${name}/manifest.json`;
          await fs.writeFile(`${dir}/${codeRel}`, code);
          await fs.writeFile(
            `${dir}/${manifestRel}`,
            `${JSON.stringify(manifest, null, 2)}\n`,
          );
          return [codeRel, manifestRel];
        },
      );
      return jsonToolResult({ ok: true, name, commit: result.commit });
    },
  };

  const listTool: ToolRegistration<typeof EmptySchema> = {
    name: "extension_list",
    description:
      "List all self-authored extensions stored in Cloudflare Artifacts along with recent commits.",
    parameters: EmptySchema,
    replay: "safe",
    async execute() {
      const artifacts = getArtifacts();
      if (!artifacts) {
        return jsonToolResult(
          { error: "ARTIFACTS binding is not configured." },
          true,
        );
      }
      return jsonToolResult(await listSavedExtensions(artifacts, repoName));
    },
  };

  const readTool: ToolRegistration<typeof ReadExtensionSchema> = {
    name: "extension_read",
    description:
      "Read the source code and manifest of a saved extension from Cloudflare Artifacts.",
    parameters: ReadExtensionSchema,
    replay: "safe",
    async execute({ name }) {
      const loaded = await loadNamedExtension(getArtifacts, repoName, name);
      if (!loaded.ok) {
        return jsonToolResult({ error: loaded.error }, true);
      }
      return jsonToolResult({
        name,
        code: loaded.code,
        manifest: loaded.manifest,
      });
    },
  };

  const runTool: ToolRegistration<typeof RunExtensionSchema> = {
    name: "extension_run",
    description:
      "Execute a saved Artifacts extension by name (or inline ES module code) inside an isolated Cloudflare Dynamic Worker sandbox with no outbound network access. Request body is JSON { input }.",
    parameters: RunExtensionSchema,
    replay: "safe",
    async execute({ name, code, input }) {
      const loader = getLoader();
      if (!loader) {
        return jsonToolResult(
          {
            error: "LOADER (Dynamic Worker Loader) binding is not configured.",
          },
          true,
        );
      }
      let source = code;
      if (!source && name) {
        const loaded = await loadNamedExtension(getArtifacts, repoName, name);
        if (!loaded.ok) {
          return jsonToolResult({ error: loaded.error }, true);
        }
        source = loaded.code;
      }
      if (!source) {
        return jsonToolResult(
          { error: "Provide either name or code to run an extension." },
          true,
        );
      }
      const result = await runInDynamicWorker(loader, source, input);
      return jsonToolResult(result, !result.ok);
    },
  };

  const deleteTool: ToolRegistration<typeof DeleteExtensionSchema> = {
    name: "extension_delete",
    description:
      "Delete a self-authored extension from Cloudflare Artifacts with a Git commit.",
    parameters: DeleteExtensionSchema,
    replay: "safe",
    async execute({ name, commitMessage }) {
      const artifacts = getArtifacts();
      if (!artifacts) {
        return jsonToolResult(
          { error: "ARTIFACTS binding is not configured." },
          true,
        );
      }
      if (!isValidExtensionName(name)) {
        return jsonToolResult({ error: "Invalid extension name." }, true);
      }
      const result = await mutateRepo(
        artifacts,
        repoName,
        commitMessage?.trim() || `Delete extension ${name}`,
        async (fs, dir) => {
          const codeRel = `extensions/${name}/index.js`;
          const manifestRel = `extensions/${name}/manifest.json`;
          await fs.unlink(`${dir}/${codeRel}`).catch(() => undefined);
          await fs.unlink(`${dir}/${manifestRel}`).catch(() => undefined);
          return [codeRel, manifestRel];
        },
      );
      return jsonToolResult({ ok: true, name, commit: result.commit });
    },
  };

  return {
    name: "extensions",
    sections: [
      {
        key: "self_extensions",
        render: () =>
          "You can author, version-control, and run your own sandboxed JavaScript extensions using extension_save, extension_list, extension_read, extension_run, and extension_delete (backed by Cloudflare Artifacts + Dynamic Worker Loaders).",
      },
    ],
    tools: [saveTool, listTool, readTool, runTool, deleteTool],
  };
}
