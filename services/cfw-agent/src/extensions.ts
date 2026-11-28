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
): Record<string, WorkerLoaderModule> {
  const modules: Record<string, WorkerLoaderModule> = {};
  for (const [relativePath, content] of rawModules) {
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
    readonly activeFacets: Set<string>;
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
    facetOptions.activeFacets.add(facetOptions.facetName);
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
  const activeFacets = new Set<string>();
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
      return;
    }
    for (const facetName of activeFacets) {
      try {
        facets.abort(facetName, "extension-updated");
      } catch {
        continue;
      }
    }
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
    name: "extension_write_file",
    description:
      "Write or update a file inside the Git-versioned extension/ workspace in Cloudflare Artifacts (extension.ts, instructions.md, or files under tools/, channels/, connections/, skills/, schedules/, subagents/, hooks/, lib/).",
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
          async (fs, dir) => {
            await fs.writeFile(`${dir}/${target.repoPath}`, content);
            return [target.repoPath];
          },
        ),
      );
      reloadActiveFacets();
      return jsonToolResult({
        ok: true,
        path: target.relativePath,
        repoPath: target.repoPath,
        commit: result.commit,
      });
    },
  };

  const listTool: ToolRegistration<typeof EmptySchema> = {
    name: "extension_list_files",
    description:
      "List all files in the extension/ workspace in Cloudflare Artifacts along with recent Git commits.",
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
      return jsonToolResult(await listExtensionFiles(artifacts, repoName));
    },
  };

  const readTool: ToolRegistration<typeof ReadFileSchema> = {
    name: "extension_read_file",
    description:
      "Read a file from the extension/ workspace in Cloudflare Artifacts.",
    parameters: ReadFileSchema,
    replay: "safe",
    async execute({ path }) {
      const target = resolveTarget(path);
      if (!target.ok) {
        return jsonToolResult({ error: target.error }, true);
      }
      const content = await readExtensionFile(
        target.artifacts,
        repoName,
        target.repoPath,
      );
      if (content === null) {
        return jsonToolResult(
          { error: `File "${target.repoPath}" not found.` },
          true,
        );
      }
      return jsonToolResult({
        path: target.relativePath,
        repoPath: target.repoPath,
        content,
      });
    },
  };

  const runTool: ToolRegistration<typeof RunExtensionSchema> = {
    name: "extension_run",
    description:
      "Execute a TypeScript/JavaScript module from extension/ (default: extension.ts) or inline code inside an isolated Dynamic Worker with no outbound network access. Pass facet (and optional className) to run a DurableObject class as a child facet with its own persistent SQLite storage.",
    parameters: RunExtensionSchema,
    replay: "safe",
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
      let facetOptions:
        | {
            readonly facets: DurableObjectFacets;
            readonly facetName: string;
            readonly className?: string;
            readonly activeFacets: Set<string>;
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
        facetOptions = {
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
          facetOptions,
        );
        return jsonToolResult(result, !result.ok);
      }
      const target = resolveTarget(path ?? DEFAULT_ENTRY_PATH);
      if (!target.ok) {
        return jsonToolResult({ error: target.error }, true);
      }
      const rawModules = await readExtensionModules(target.artifacts, repoName);
      if (!rawModules.has(target.relativePath)) {
        return jsonToolResult(
          { error: `Module "${target.repoPath}" not found.` },
          true,
        );
      }
      const modules = buildWorkerModules(rawModules);
      const result = await runInDynamicWorker(
        loader,
        target.relativePath,
        modules,
        input,
        facetOptions,
      );
      return jsonToolResult(result, !result.ok);
    },
  };

  const deleteTool: ToolRegistration<typeof DeleteFileSchema> = {
    name: "extension_delete_file",
    description:
      "Delete an existing file from the extension/ workspace in Cloudflare Artifacts with a Git commit.",
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
        commit: result.commit,
      });
    },
  };

  return {
    name: "extensions",
    sections: [
      {
        key: "self_extensions",
        render: () =>
          "You own a Git-versioned extension/ workspace in Cloudflare Artifacts with layout: extension.ts, tools/, channels/, connections/, skills/, schedules/, subagents/, hooks/, instructions.md, and lib/. Use extension_write_file, extension_list_files, extension_read_file, extension_delete_file, and extension_run (Dynamic Worker sandbox, with optional Durable Object facets for persistent per-feature SQLite state).",
      },
    ],
    tools: [writeTool, listTool, readTool, runTool, deleteTool],
  };
}
