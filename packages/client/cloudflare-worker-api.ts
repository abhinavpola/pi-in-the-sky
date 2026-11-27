import { z } from "zod";

import workerBundle from "./generated/worker-bundle.json";

export const DEFAULT_WORKER_NAME = "pi-in-the-sky-agent";

const WORKER_METADATA = {
  main_module: "index.js",
  compatibility_date: "2026-11-27",
  compatibility_flags: ["nodejs_compat"],
  bindings: [
    {
      type: "durable_object_namespace",
      name: "PersonalAgent",
      class_name: "PersonalAgent",
    },
    {
      type: "browser",
      name: "BROWSER",
    },
    {
      type: "worker_loader",
      name: "LOADER",
    },
    {
      type: "artifacts",
      name: "ARTIFACTS",
      namespace: "default",
    },
  ],
  migrations: {
    new_tag: "v1",
    new_sqlite_classes: ["PersonalAgent"],
  },
  observability: {
    enabled: true,
  },
};

const SubdomainResponseSchema = z.object({
  result: z.object({
    subdomain: z.string().min(1),
  }),
});

const CfErrorResponseSchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string().min(1),
      }),
    )
    .optional(),
});

export type DeployedWorker = {
  readonly accountId: string;
  readonly accountName: string;
  readonly baseUrl: string;
};

type WorkerDeployResult =
  | { readonly ok: true; readonly worker: DeployedWorker }
  | { readonly ok: false; readonly error: string };

type WorkerDestroyResult =
  { readonly ok: true } | { readonly ok: false; readonly error: string };

async function readCloudflareError(
  response: Response,
  fallbackPrefix: string,
): Promise<string> {
  try {
    const parsed = CfErrorResponseSchema.safeParse(await response.json());
    const message = parsed.success ? parsed.data.errors?.[0]?.message : null;
    if (message) {
      return message;
    }
  } catch {
    return `${fallbackPrefix} (HTTP ${response.status})`;
  }
  return `${fallbackPrefix} (HTTP ${response.status})`;
}

function randomBoundarySuffix(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function buildWorkerMultipart(code: string): {
  readonly boundary: string;
  readonly body: string;
} {
  let boundary = `----PiInTheSkyBoundary${randomBoundarySuffix()}`;
  while (code.includes(boundary)) {
    boundary = `----PiInTheSkyBoundary${randomBoundarySuffix()}`;
  }
  const metadataJson = JSON.stringify(WORKER_METADATA);
  const body = [
    `--${boundary}`,
    'Content-Disposition: form-data; name="metadata"',
    "Content-Type: application/json",
    "",
    metadataJson,
    `--${boundary}`,
    'Content-Disposition: form-data; name="index.js"; filename="index.js"',
    "Content-Type: application/javascript+module",
    "",
    code,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return { boundary, body };
}

async function ensureWorkersSubdomain(
  cleanAccount: string,
  accountId: string,
  authHeader: string,
): Promise<
  | { readonly ok: true; readonly subdomain: string }
  | { readonly ok: false; readonly error: string }
> {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/subdomain`;
  const existingRes = await fetch(endpoint, {
    headers: { Authorization: authHeader },
  });
  if (existingRes.ok) {
    const parsed = SubdomainResponseSchema.safeParse(await existingRes.json());
    if (!parsed.success) {
      return { ok: false, error: "Unexpected Cloudflare subdomain shape." };
    }
    return { ok: true, subdomain: parsed.data.result.subdomain };
  }
  if (existingRes.status !== 404) {
    return {
      ok: false,
      error: await readCloudflareError(
        existingRes,
        "Could not read workers.dev subdomain",
      ),
    };
  }

  const basePrefix = accountId
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 12)
    .toLowerCase();
  const candidates = [
    `pi-${basePrefix || "agent"}`,
    `pi-${basePrefix || "agent"}-${randomBoundarySuffix().slice(-6)}`,
  ];
  for (const candidate of candidates) {
    const createRes = await fetch(endpoint, {
      method: "PUT",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ subdomain: candidate }),
    });
    if (createRes.ok) {
      const parsed = SubdomainResponseSchema.safeParse(await createRes.json());
      return {
        ok: true,
        subdomain: parsed.success ? parsed.data.result.subdomain : candidate,
      };
    }
    if (createRes.status !== 409) {
      return {
        ok: false,
        error: await readCloudflareError(
          createRes,
          "Could not register workers.dev subdomain",
        ),
      };
    }
  }
  return {
    ok: false,
    error: "Could not register an available workers.dev subdomain.",
  };
}

export async function deployCloudflareWorker(
  cfApiToken: string,
  accountId: string,
  accountName: string,
): Promise<WorkerDeployResult> {
  if (!workerBundle.code) {
    return {
      ok: false,
      error: "Worker bundle is empty. Rebuild the app with bun run macos.",
    };
  }
  const cleanAccount = encodeURIComponent(accountId.trim());
  const authHeader = `Bearer ${cfApiToken.trim()}`;
  try {
    const { boundary, body } = buildWorkerMultipart(workerBundle.code);
    const uploadRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/scripts/${DEFAULT_WORKER_NAME}`,
      {
        method: "PUT",
        headers: {
          Authorization: authHeader,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!uploadRes.ok) {
      return {
        ok: false,
        error: await readCloudflareError(uploadRes, "Worker deployment failed"),
      };
    }

    const ensuredSubdomain = await ensureWorkersSubdomain(
      cleanAccount,
      accountId,
      authHeader,
    );
    if (!ensuredSubdomain.ok) {
      return ensuredSubdomain;
    }

    const enableRes = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/scripts/${DEFAULT_WORKER_NAME}/subdomain`,
      {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      },
    );
    if (!enableRes.ok) {
      return {
        ok: false,
        error: await readCloudflareError(
          enableRes,
          "Could not enable workers.dev route",
        ),
      };
    }

    return {
      ok: true,
      worker: {
        accountId,
        accountName,
        baseUrl: `https://${DEFAULT_WORKER_NAME}.${ensuredSubdomain.subdomain}.workers.dev`,
      },
    };
  } catch (thrown) {
    return {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}

export async function destroyCloudflareWorker(
  cfApiToken: string,
  accountId: string,
): Promise<WorkerDestroyResult> {
  const cleanAccount = encodeURIComponent(accountId.trim());
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cleanAccount}/workers/scripts/${DEFAULT_WORKER_NAME}?force=true`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${cfApiToken.trim()}` },
      },
    );
    if (response.ok || response.status === 404) {
      return { ok: true };
    }
    return {
      ok: false,
      error: await readCloudflareError(response, "Could not destroy Worker"),
    };
  } catch (thrown) {
    return {
      ok: false,
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
}
