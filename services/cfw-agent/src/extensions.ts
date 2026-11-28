import { posix } from "node:path";

import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { obj, opt, str, unknown } from "@earendil-works/pi-schema";

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
import type { ConnectorBridge } from "./connector-bridge";
import {
  buildWorkerModules,
  compileTsModule,
  type DynamicRunResult,
  runInDynamicWorker,
} from "./dynamic-runner";
import { jsonToolResult } from "./http-tool";

const ARTIFACTS_REPO_PREFIX = "agent-extension";
const FACET_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DEFAULT_ENTRY_PATH = "extension.ts";

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

type ExtensionModuleRunRequest = {
  readonly path?: string;
  readonly code?: string;
  readonly input?: unknown;
  readonly facet?: string;
  readonly className?: string;
};

export type ExtensionModuleRunner = (
  request: ExtensionModuleRunRequest,
) => Promise<DynamicRunResult>;

export function createExtensionsRuntime(options: {
  readonly getArtifacts: () => Artifacts | undefined;
  readonly getLoader: () => WorkerLoader | undefined;
  readonly getFacets: () => DurableObjectFacets | undefined;
  readonly getConnectorBridge?: () => ConnectorBridge | undefined;
  readonly agentScope: string;
}): {
  readonly extension: Extension;
  readonly runModule: ExtensionModuleRunner;
} {
  const { getArtifacts, getLoader, getFacets, getConnectorBridge, agentScope } =
    options;
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
        void 0;
      }
    }
  };

  const resolveTarget = (
    rawPath: string,
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
      return {
        ok: false,
        error: "ARTIFACTS binding is not configured on this Worker.",
      };
    }
    const normalized = normalizeExtensionPath(rawPath);
    if (!normalized) {
      return { ok: false, error: INVALID_PATH_ERROR };
    }
    return { ok: true, artifacts, ...normalized };
  };

  const runModule: ExtensionModuleRunner = async ({
    path,
    code,
    input,
    facet,
    className,
  }) => {
    const loader = getLoader();
    if (!loader) {
      return {
        ok: false,
        status: 500,
        output: {
          error: "LOADER (Dynamic Worker Loader) binding is not configured.",
        },
      };
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
        return {
          ok: false,
          status: 400,
          output: {
            error:
              "Invalid facet name. Use 1-64 lowercase letters, digits, hyphens, or underscores.",
          },
        };
      }
      const facets = getFacets();
      if (!facets) {
        return {
          ok: false,
          status: 500,
          output: { error: "Durable Object facets are not available." },
        };
      }
      facetTarget = { facets, facetName: facet, className, activeFacets };
    }
    const connectorBridge = getConnectorBridge?.();
    if (code) {
      return runInDynamicWorker(
        loader,
        DEFAULT_ENTRY_PATH,
        { [DEFAULT_ENTRY_PATH]: { js: compileTsModule(code) } },
        input,
        {
          connectorBridge,
          ...(facetTarget
            ? {
                facet: {
                  ...facetTarget,
                  handlerKey: `inline:${className ?? ""}:${code}`,
                },
              }
            : {}),
        },
      );
    }
    const normalized = normalizeExtensionPath(path ?? DEFAULT_ENTRY_PATH);
    if (!normalized) {
      return { ok: false, status: 400, output: { error: INVALID_PATH_ERROR } };
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
      return {
        ok: false,
        status: 404,
        output: { error: `Module "${normalized.repoPath}" not found.` },
      };
    }
    const modules = buildWorkerModules(rawModules, normalized.relativePath);
    return runInDynamicWorker(loader, normalized.relativePath, modules, input, {
      connectorBridge,
      ...(facetTarget
        ? {
            facet: {
              ...facetTarget,
              handlerKey: `repo:${normalized.relativePath}:${className ?? ""}`,
            },
          }
        : {}),
    });
  };

  const writeTool: ToolRegistration<typeof WriteFileSchema> = {
    name: "write_file",
    description:
      "Create or update a file inside your extension/ workspace (e.g. extension.ts, instructions.md, tools/inbox.ts, skills/triage/SKILL.md, schedules/daily.ts, lib/helpers.ts) and commit it to Cloudflare Artifacts. Writing a built-in path overrides it.",
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
      "Read a file from your extension/ workspace (checks Cloudflare Artifacts overrides first, then bundled built-ins).",
    parameters: ReadFileSchema,
    replay: "safe",
    async execute({ path }) {
      const normalized = normalizeExtensionPath(path);
      if (!normalized) {
        return jsonToolResult({ error: INVALID_PATH_ERROR }, true);
      }
      const artifacts = getArtifacts();
      const repoContent = artifacts
        ? await readExtensionFile(artifacts, repoName, normalized.repoPath)
        : null;
      if (repoContent !== null) {
        return jsonToolResult({
          path: normalized.relativePath,
          repoPath: normalized.repoPath,
          source:
            getBuiltinExtensionFile(normalized.relativePath) !== null
              ? "override"
              : "user",
          content: repoContent,
        });
      }
      const builtinContent = getBuiltinExtensionFile(normalized.relativePath);
      if (builtinContent !== null) {
        return jsonToolResult({
          path: normalized.relativePath,
          repoPath: normalized.repoPath,
          source: "builtin",
          content: builtinContent,
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
      "Execute a TypeScript/JavaScript module from extension/ (default: extension.ts) or inline code inside an isolated Dynamic Worker with no outbound network access (approved connectors are bridged via env.CONNECTOR_BRIDGE). Pass facet (and optional className) to run a DurableObject class as a child facet with its own persistent SQLite storage.",
    parameters: RunExtensionSchema,
    replay: "unsafe",
    async execute(args) {
      const result = await runModule(args);
      return jsonToolResult(result, !result.ok);
    },
  };

  const deleteTool: ToolRegistration<typeof DeleteFileSchema> = {
    name: "delete_file",
    description:
      "Delete a file from your Cloudflare Artifacts extension/ workspace (deleting an override restores the bundled built-in file).",
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
          async (fsPromises, dir) => {
            await fsPromises
              .unlink(posix.join(dir, target.repoPath))
              .catch(() => undefined);
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

  const skillCatalogLines = listBuiltinSkills().map(
    (skill) => `- ${skill.name} (${skill.path}): ${skill.description}`,
  );

  return {
    runModule,
    extension: {
      name: "extensions",
      tools: [writeTool, listTool, readTool, runTool, deleteTool],
      sections: [
        {
          key: "extension-workspace",
          render: () =>
            "You own a Git-versioned extension/ workspace (bundled built-ins overlaid with your Cloudflare Artifacts repo) with layout: extension.ts, tools/, channels/, connections/, skills/, schedules/, subagents/, hooks/, instructions.md, and lib/. Use list_files, read_file, write_file, delete_file, and run_module (Dynamic Worker sandbox, with optional Durable Object facets for persistent per-feature SQLite state).",
        },
        {
          key: "skills-catalog",
          render: () =>
            [
              "Built-in skills (inspect or load with read_file):",
              ...skillCatalogLines,
            ].join("\n"),
        },
      ],
    },
  };
}
