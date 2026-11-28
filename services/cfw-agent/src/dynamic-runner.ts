import { WorkerEntrypoint } from "cloudflare:workers";
import { transform } from "sucrase";

import type { ConnectorBridge } from "./connector-bridge";

const DYNAMIC_COMPAT_DATE = "2026-11-27";
const RPC_WRAPPER_MODULE = "__pi_runner__.js";

export type DynamicRunResult = {
  readonly ok: boolean;
  readonly status: number;
  readonly output: unknown;
};

type DynamicFacetOptions = {
  readonly facets: DurableObjectFacets;
  readonly facetName: string;
  readonly className?: string;
  readonly handlerKey: string;
  readonly activeFacets: Map<string, string>;
};

export function compileTsModule(source: string): string {
  return transform(source, {
    transforms: ["typescript"],
    disableESTransforms: true,
  }).code;
}

export function buildWorkerModules(
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

function parseBody(contentType: string, rawText: string): unknown {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(rawText);
    } catch {
      return rawText;
    }
  }
  return rawText;
}

async function parseWorkerResponse(
  response: Response,
): Promise<DynamicRunResult> {
  const contentType = response.headers.get("Content-Type") ?? "";
  const rawText = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    output: parseBody(contentType, rawText),
  };
}

function runWorkerRequest(input: unknown): Request {
  return new Request("https://extension.internal/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: input ?? null }),
  });
}

function buildRpcWrapperSource(mainModule: string): string {
  return [
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    `import handler from ${JSON.stringify(`./${mainModule}`)};`,
    "export default class extends WorkerEntrypoint {",
    "  async run(input, connectorBridge) {",
    '    const request = new Request("https://extension.internal/run", {',
    '      method: "POST",',
    '      headers: { "Content-Type": "application/json" },',
    "      body: JSON.stringify({ input: input ?? null }),",
    "    });",
    "    const response = await handler.fetch(request, {",
    "      CONNECTOR_BRIDGE: connectorBridge,",
    "    });",
    "    return {",
    "      ok: response.ok,",
    "      status: response.status,",
    '      contentType: response.headers.get("Content-Type") ?? "",',
    "      body: await response.text(),",
    "    };",
    "  }",
    "}",
  ].join("\n");
}

abstract class RpcRunnerEntrypoint extends WorkerEntrypoint {
  abstract run(
    input: unknown,
    connectorBridge: ConnectorBridge | undefined,
  ): Promise<{
    readonly ok: boolean;
    readonly status: number;
    readonly contentType: string;
    readonly body: string;
  }>;
}

export async function runInDynamicWorker(
  loader: WorkerLoader,
  mainModule: string,
  modules: Record<string, WorkerLoaderModule>,
  input: unknown,
  options?: {
    readonly facet?: DynamicFacetOptions;
    readonly connectorBridge?: ConnectorBridge;
  },
): Promise<DynamicRunResult> {
  if (options?.facet) {
    const facetOptions = options.facet;
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
      class: loader
        .load({
          compatibilityDate: DYNAMIC_COMPAT_DATE,
          compatibilityFlags: ["nodejs_compat"],
          mainModule,
          modules,
          globalOutbound: null,
          limits: {
            cpuMs: 50,
            subRequests: 0,
          },
        })
        .getDurableObjectClass(facetOptions.className),
    }));
    const response = await facet.fetch(runWorkerRequest(input));
    return parseWorkerResponse(response);
  }
  const worker = loader.load({
    compatibilityDate: DYNAMIC_COMPAT_DATE,
    compatibilityFlags: ["nodejs_compat"],
    mainModule: RPC_WRAPPER_MODULE,
    modules: {
      ...modules,
      [RPC_WRAPPER_MODULE]: { js: buildRpcWrapperSource(mainModule) },
    },
    globalOutbound: null,
    limits: {
      cpuMs: 50,
      subRequests: 0,
    },
  });
  const entrypoint = worker.getEntrypoint<RpcRunnerEntrypoint>();
  const raw = await entrypoint.run(input, options?.connectorBridge);
  return {
    ok: raw.ok,
    status: raw.status,
    output: parseBody(raw.contentType, raw.body),
  };
}
