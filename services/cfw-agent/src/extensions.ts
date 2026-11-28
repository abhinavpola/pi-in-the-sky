import { posix } from "node:path";

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { transform } from "sucrase";

import {
  listExtensionFiles,
  mutateRepo,
  normalizeExtensionPath,
  readExtensionFile,
  readExtensionModules,
} from "./artifacts-store";
import {
  getBuiltinExtensionFile,
  getBuiltinExtensionFiles,
  listBuiltinSkills,
  mergeExtensionFileListing,
} from "./builtin-extension";
import { jsonToolResult } from "./http-tool";

const ARTIFACTS_REPO_PREFIX = "agent-extension";
const FACET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_ENTRY_PATH = "extension.ts";
const DYNAMIC_COMPAT_DATE = "2026-11-27";

function compileTsModule(source: string): string {
  return transform(source, { transforms: ["typescript"] }).code;
}

function buildWorkerModules(
  rawModules: ReadonlyMap<string, string>,
  mainModule: string,
): Record<string, WorkerLoaderModule> {
  const modules: Record<string, WorkerLoaderModule> = {};
  for (const [relativePath, content] of rawModules) {
    try {
      if (relativePath.endsWith(".json")) {
        modules[relativePath] = { json: JSON.parse(content) };
        continue;
      }
      const js = relativePath.endsWith(".ts")
        ? compileTsModule(content)
        : content;
      modules[relativePath] = { js };
      if (relativePath.endsWith(".ts")) {
        const withoutExt = relativePath.slice(0, -3);
        modules[`${withoutExt}.js`] = { js };
        modules[withoutExt] = { js };
      }
    } catch (thrown) {
      if (relativePath === mainModule) {
        throw thrown;
      }
    }
  }
  return modules;
}

async function parseWorkerResponse(response: Response): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly output: unknown;
}> {
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

function runWorkerRequest(input: unknown): Request {
  return new Request("https://extension.internal/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: input ?? null }),
  });
}

async function runInDynamicWorker(
  loader: WorkerLoader,
  mainModule: string,
  modules: Record<string, WorkerLoaderModule>,
  input: unknown,
  facetOptions?: {
    readonly facets: DurableObjectFacets;
    readonly facetName: string;
    readonly className?: string;
    readonly handlerKey: string;
    readonly activeFacets: Map<string, string>;
  },
): Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly output: unknown;
}> {
  const loadWorker = () =>
    loader.load({
      compatibilityDate: DYNAMIC_COMPAT_DATE,
      mainModule,
      modules,
      globalOutbound: null,
      limits: {
        cpuMs: 50,
        subRequests: 0,
      },
    });
  if (facetOptions) {
    const previousKey = facetOptions.activeFacets.get(facetOptions.facetName);
    if (previousKey !== undefined && previousKey !== facetOptions.handlerKey) {
      try {
        facetOptions.facets.abort(facetOptions.facetName, "handler-changed");
      } catch {
        void 0;
      }
    }
    facetOptions.activeFacets.set(
      facetOptions.facetName,
      facetOptions.handlerKey,
    );
    const facet = facetOptions.facets.get(facetOptions.facetName, () => ({
      class: loadWorker().getDurableObjectClass(facetOptions.className),
    }));
    const response = await facet.fetch(runWorkerRequest(input));
    return parseWorkerResponse(response);
  }
  const response = await loadWorker()
    .getEntrypoint()
    .fetch(runWorkerRequest(input));
  return parseWorkerResponse(response);
}

const EmptySchema = obj({});

const WriteFileSchema = obj({
  path: str(),
  content: str(),
  commitMessage: opt(str()),
});

const ReadFileSchema = obj({
  path: str(),
});

const RunExtensionSchema = obj({
  path: opt(str()),
  code: opt(str()),
  input: opt(unknown()),
  facet: opt(str()),
  className: opt(str()),
});

const DeleteFileSchema = obj({
  path: str(),
  commitMessage: opt(str()),
});

const INVALID_PATH_ERROR =
  "Invalid path. Files must live under extension/ as extension.ts, instructions.md, or inside tools/, channels/, connections/, skills/, schedules/, subagents/, hooks/, or lib/.";

export function createExtensionsExtension(
  getArtifacts: () => Artifacts | undefined,
  getLoader: () => WorkerLoader | undefined,
  getFacets: () => DurableObjectFacets | undefined,
  agentScope: string,
): Extension {
  const cleanScope = agentScope
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
  const repoName = cleanScope
    ? `${ARTIFACTS_REPO_PREFIX}-${cleanScope}`
    : ARTIFACTS_REPO_PREFIX;
  const activeFacets = new Map<string, string>();
  let mutationChain: Promise<unknown> = Promise.resolve();
  const enqueueMutation = <T>(run: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(run, run);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const reloadActiveFacets = (): void => {
    const facets = getFacets();
    if (!facets) {
      activeFacets.clear();
      return;
    }
    for (const facetName of activeFacets.keys()) {
      try {
        facets.abort(facetName, "extension-updated");
      } catch {
        continue;
      }
    }
    activeFacets.clear();
  };

  const resolveTarget = (
    path: string,
  ):
    | {
        readonly ok: true;
        readonly artifacts: Artifacts;
        readonly relativePath: string;
        readonly repoPath: string;
      }
    | { readonly ok: false; readonly error: string } => {
    const artifacts = getArtifacts();
    if (!artifacts) {
      return { ok: false, error: "ARTIFACTS binding is not configured." };
    }
    const normalized = normalizeExtensionPath(path);
    if (!normalized) {
      return { ok: false, error: INVALID_PATH_ERROR };
    }
    return { ok: true, artifacts, ...normalized };
  };

  const writeTool: ToolRegistration<typeof WriteFileSchema> = {
    name: "write_file",
    description:
      "Write or update a file inside your extension/ workspace in Cloudflare Artifacts (extension.ts, instructions.md, or files under tools/, channels/, connections/, skills/, schedules/, subagents/, hooks/, lib/). Writing a built-in path overrides the bundled default.",
    parameters: WriteFileSchema,
    replay: "safe",
    async execute({ path, content, commitMessage }) {
      const target = resolveTarget(path);
      if (!target.ok) {
        return jsonToolResult({ error: target.error }, true);
      }
      const result = await enqueueMutation(() =>
        mutateRepo(
          target.artifacts,
          repoName,
          commitMessage?.trim() || `Update ${target.repoPath}`,
          async (fsPromises, dir) => {
            const fullPath = posix.join(dir, target.repoPath);
            await fsPromises.mkdir(posix.dirname(fullPath), {
              recursive: true,
            });
            await fsPromises.writeFile(fullPath, content, "utf8");
            return [target.repoPath];
          },
        ),
      );
      reloadActiveFacets();
      return jsonToolResult({
        ok: true,
        path: target.relativePath,
        repoPath: target.repoPath,
        source:
          getBuiltinExtensionFile(target.relativePath) !== null
            ? "override"
            : "user",
        commit: result.commit,
      });
    },
  };

  const listTool: ToolRegistration<typeof EmptySchema> = {
    name: "list_files",
    description:
      "List all files in your extension/ workspace (bundled built-ins overlaid with your Cloudflare Artifacts files) along with recent Git commits.",
    parameters: EmptySchema,
    replay: "safe",
    async execute() {
      const artifacts = getArtifacts();
      const repoListing = artifacts
        ? await listExtensionFiles(artifacts, repoName)
        : { files: [], recentCommits: [] };
      return jsonToolResult({
        files: mergeExtensionFileListing(repoListing.files),
        recentCommits: repoListing.recentCommits,
      });
    },
  };

  const readTool: ToolRegistration<typeof ReadFileSchema> = {
    name: "read_file",
    description:
      "Read a file from your extension/ workspace (checks your Cloudflare Artifacts overrides first, then bundled built-in files like instructions.md or skills/<name>/SKILL.md).",
    parameters: ReadFileSchema,
    replay: "safe",
    async execute({ path }) {
      const normalized = normalizeExtensionPath(path);
      if (!normalized) {
        return jsonToolResult({ error: INVALID_PATH_ERROR }, true);
      }
      const builtin = getBuiltinExtensionFile(normalized.relativePath);
      const artifacts = getArtifacts();
      const repoContent = artifacts
        ? await readExtensionFile(artifacts, repoName, normalized.repoPath)
        : null;
      if (repoContent !== null) {
        return jsonToolResult({
          path: normalized.relativePath,
          repoPath: normalized.repoPath,
          source: builtin !== null ? "override" : "user",
          content: repoContent,
        });
      }
      if (builtin !== null) {
        return jsonToolResult({
          path: normalized.relativePath,
          repoPath: normalized.repoPath,
          source: "builtin",
          content: builtin,
        });
      }
      return jsonToolResult(
        { error: `File "${normalized.repoPath}" not found.` },
        true,
      );
    },
  };

  const runTool: ToolRegistration<typeof RunExtensionSchema> = {
    name: "run_module",
    description:
      "Execute a TypeScript/JavaScript module from extension/ (default: extension.ts) or inline code inside an isolated Dynamic Worker with no outbound network access. Pass facet (and optional className) to run a DurableObject class as a child facet with its own persistent SQLite storage.",
    parameters: RunExtensionSchema,
    replay: "unsafe",
    async execute({ path, code, input, facet, className }) {
      const loader = getLoader();
      if (!loader) {
        return jsonToolResult(
          {
            error: "LOADER (Dynamic Worker Loader) binding is not configured.",
          },
          true,
        );
      }
      let facetTarget:
        | {
            readonly facets: DurableObjectFacets;
            readonly facetName: string;
            readonly className?: string;
            readonly activeFacets: Map<string, string>;
          }
        | undefined;
      if (facet !== undefined) {
        if (!FACET_NAME_PATTERN.test(facet)) {
          return jsonToolResult(
            {
              error:
                "Invalid facet name. Use 1-64 lowercase letters, digits, hyphens, or underscores.",
            },
            true,
          );
        }
        const facets = getFacets();
        if (!facets) {
          return jsonToolResult(
            { error: "Durable Object facets are not available." },
            true,
          );
        }
        facetTarget = {
          facets,
          facetName: facet,
          className,
          activeFacets,
        };
      }
      if (code) {
        const result = await runInDynamicWorker(
          loader,
          DEFAULT_ENTRY_PATH,
          { [DEFAULT_ENTRY_PATH]: { js: compileTsModule(code) } },
          input,
          facetTarget
            ? {
                ...facetTarget,
                handlerKey: `inline:${className ?? ""}:${code}`,
              }
            : undefined,
        );
        return jsonToolResult(result, !result.ok);
      }
      const normalized = normalizeExtensionPath(path ?? DEFAULT_ENTRY_PATH);
      if (!normalized) {
        return jsonToolResult({ error: INVALID_PATH_ERROR }, true);
      }
      const rawModules = new Map<string, string>(getBuiltinExtensionFiles());
      const artifacts = getArtifacts();
      if (artifacts) {
        const repoModules = await readExtensionModules(artifacts, repoName);
        for (const [modPath, modSource] of repoModules) {
          rawModules.set(modPath, modSource);
        }
      }
      if (!rawModules.has(normalized.relativePath)) {
        return jsonToolResult(
          { error: `Module "${normalized.repoPath}" not found.` },
          true,
        );
      }
      const modules = buildWorkerModules(rawModules, normalized.relativePath);
      const result = await runInDynamicWorker(
        loader,
        normalized.relativePath,
        modules,
        input,
        facetTarget
          ? {
              ...facetTarget,
              handlerKey: `repo:${normalized.relativePath}:${className ?? ""}`,
            }
          : undefined,
      );
      return jsonToolResult(result, !result.ok);
    },
  };

  const deleteTool: ToolRegistration<typeof DeleteFileSchema> = {
    name: "delete_file",
    description:
      "Delete an existing user-authored file or override from your extension/ workspace in Cloudflare Artifacts with a Git commit (deleting an override restores the bundled built-in file).",
    parameters: DeleteFileSchema,
    replay: "safe",
    async execute({ path, commitMessage }) {
      const target = resolveTarget(path);
      if (!target.ok) {
        return jsonToolResult({ error: target.error }, true);
      }
      const result = await enqueueMutation(async () => {
        const existing = await readExtensionFile(
          target.artifacts,
          repoName,
          target.repoPath,
        );
        if (existing === null) {
          return null;
        }
        return mutateRepo(
          target.artifacts,
          repoName,
          commitMessage?.trim() || `Delete ${target.repoPath}`,
          async (fs, dir) => {
            await fs.unlink(`${dir}/${target.repoPath}`).catch(() => undefined);
            return [target.repoPath];
          },
        );
      });
      if (!result) {
        return jsonToolResult(
          { error: `File "${target.repoPath}" not found.` },
          true,
        );
      }
      reloadActiveFacets();
      return jsonToolResult({
        ok: true,
        path: target.relativePath,
        repoPath: target.repoPath,
        restoredBuiltin: getBuiltinExtensionFile(target.relativePath) !== null,
        commit: result.commit,
      });
    },
  };

  const skills = listBuiltinSkills();

  return {
    name: "extensions",
    sections: [
      {
        key: "self_extensions",
        render: () =>
          "You own a Git-versioned extension/ workspace (bundled built-ins overlaid with your Cloudflare Artifacts repo) with layout: extension.ts, tools/, channels/, connections/, skills/, schedules/, subagents/, hooks/, instructions.md, and lib/. Use list_files, read_file, write_file, delete_file, and run_module (Dynamic Worker sandbox, with optional Durable Object facets for persistent per-feature SQLite state).",
      },
      {
        key: "available_skills",
        render: () =>
          [
            "Built-in skills (call read_file on the skill path when relevant; use list_files to see any custom skills):",
            ...skills.map(
              (skill) =>
                `- ${skill.name} (${skill.path}): ${skill.description}`,
            ),
          ].join("\n"),
      },
    ],
    tools: [writeTool, listTool, readTool, runTool, deleteTool],
  };
}
