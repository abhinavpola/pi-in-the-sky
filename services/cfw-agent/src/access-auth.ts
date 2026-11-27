import { z } from "zod";

function fromBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

type AccessConfig = {
  readonly teamDomain?: string;
  readonly aud?: string;
  readonly jwksJson?: string;
};

type AccessIdentity = {
  readonly sub: string;
  readonly email: string | null;
  readonly exp: number;
};

const JwtHeaderSchema = z.object({
  alg: z.string(),
  kid: z.string().min(1),
});

const JwtPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]),
  iss: z.string().min(1),
  exp: z.number(),
  nbf: z.number().optional(),
});

const JwkSchema = z.object({
  kty: z.literal("RSA"),
  kid: z.string().min(1),
  n: z.string().min(1),
  e: z.string().min(1),
  alg: z.string().optional(),
  use: z.string().optional(),
});

const JwksResponseSchema = z.object({
  keys: z.array(JwkSchema),
});

type CachedJwks = {
  readonly keys: readonly z.infer<typeof JwkSchema>[];
  readonly fetchedAt: number;
};

const JWKS_CACHE_TTL_MS = 5 * 60 * 1000;
const jwksCache = new Map<string, CachedJwks>();

function base64UrlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(input.length / 4) * 4, "=");
  return fromBase64(padded);
}

function decodeJsonSegment(segment: string): unknown {
  try {
    const text = new TextDecoder().decode(base64UrlToBytes(segment));
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeTeamOrigin(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/$/, "");
  if (trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

async function loadJwks(
  config: AccessConfig,
  fetcher: typeof fetch,
): Promise<readonly z.infer<typeof JwkSchema>[]> {
  if (config.jwksJson) {
    const parsed = JwksResponseSchema.safeParse(JSON.parse(config.jwksJson));
    return parsed.success ? parsed.data.keys : [];
  }
  if (!config.teamDomain) {
    return [];
  }
  const origin = normalizeTeamOrigin(config.teamDomain);
  const cached = jwksCache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL_MS) {
    return cached.keys;
  }
  const response = await fetcher(`${origin}/cdn-cgi/access/certs`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    return [];
  }
  const parsed = JwksResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    return [];
  }
  jwksCache.set(origin, { keys: parsed.data.keys, fetchedAt: Date.now() });
  return parsed.data.keys;
}

function extractJwt(request: Request): string | null {
  const cfHeader = request.headers.get("Cf-Access-Jwt-Assertion");
  if (cfHeader && cfHeader.trim().length > 0) {
    return cfHeader.trim();
  }
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice("Bearer ".length).trim();
    if (token.split(".").length === 3) {
      return token;
    }
  }
  return null;
}

function matchesAudience(
  aud: string | readonly string[],
  expected: string,
): boolean {
  if (typeof aud === "string") {
    return aud === expected;
  }
  return aud.includes(expected);
}

export async function verifyCloudflareAccessJwt(
  request: Request,
  config: AccessConfig,
  fetcher: typeof fetch = fetch,
): Promise<AccessIdentity | null> {
  if (!config.teamDomain || !config.aud) {
    return null;
  }
  const token = extractJwt(request);
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (!headerSeg || !payloadSeg || !sigSeg) {
    return null;
  }

  const headerParsed = JwtHeaderSchema.safeParse(decodeJsonSegment(headerSeg));
  if (!headerParsed.success || headerParsed.data.alg !== "RS256") {
    return null;
  }

  const payloadParsed = JwtPayloadSchema.safeParse(
    decodeJsonSegment(payloadSeg),
  );
  if (!payloadParsed.success) {
    return null;
  }

  const payload = payloadParsed.data;
  const expectedIssuer = normalizeTeamOrigin(config.teamDomain);
  const nowSec = Math.floor(Date.now() / 1000);
  if (
    payload.iss.replace(/\/$/, "") !== expectedIssuer ||
    !matchesAudience(payload.aud, config.aud) ||
    payload.exp <= nowSec ||
    (payload.nbf !== undefined && payload.nbf > nowSec)
  ) {
    return null;
  }

  const keys = await loadJwks(config, fetcher);
  const jwk = keys.find((item) => item.kid === headerParsed.data.kid);
  if (!jwk) {
    return null;
  }

  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
        alg: "RS256",
        ext: true,
      },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signingInput = new TextEncoder().encode(`${headerSeg}.${payloadSeg}`);
    const signature = base64UrlToBytes(sigSeg);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      signingInput,
    );
    if (!valid) {
      return null;
    }
    return {
      sub: payload.sub,
      email: payload.email ?? null,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}
