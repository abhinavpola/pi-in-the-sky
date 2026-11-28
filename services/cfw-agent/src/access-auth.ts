import {
  createLocalJWKSet,
  createRemoteJWKSet,
  type JSONWebKeySet,
  jwtVerify,
} from "jose";
import { z } from "zod";

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

const VerifiedPayloadSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  exp: z.number(),
});

const JwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())),
});

const remoteJwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();

function normalizeTeamOrigin(teamDomain: string): string {
  const trimmed = teamDomain.trim().replace(/\/$/, "");
  if (trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
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

function getKeyResolver(
  config: AccessConfig,
  origin: string,
):
  | ReturnType<typeof createLocalJWKSet>
  | ReturnType<typeof createRemoteJWKSet>
  | null {
  if (config.jwksJson) {
    try {
      const parsed = JwksSchema.safeParse(JSON.parse(config.jwksJson));
      if (!parsed.success) {
        return null;
      }
      const jwks: JSONWebKeySet = { keys: parsed.data.keys };
      return createLocalJWKSet(jwks);
    } catch {
      return null;
    }
  }
  const existing = remoteJwksCache.get(origin);
  if (existing) {
    return existing;
  }
  try {
    const remote = createRemoteJWKSet(
      new URL(`${origin}/cdn-cgi/access/certs`),
    );
    remoteJwksCache.set(origin, remote);
    return remote;
  } catch {
    return null;
  }
}

export async function verifyCloudflareAccessJwt(
  request: Request,
  config: AccessConfig,
): Promise<AccessIdentity | null> {
  if (!config.teamDomain || !config.aud) {
    return null;
  }
  const token = extractJwt(request);
  if (!token) {
    return null;
  }
  const origin = normalizeTeamOrigin(config.teamDomain);
  const keyResolver = getKeyResolver(config, origin);
  if (!keyResolver) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, keyResolver, {
      issuer: [origin, `${origin}/`],
      audience: config.aud,
      algorithms: ["RS256"],
    });
    const parsed = VerifiedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return null;
    }
    return {
      sub: parsed.data.sub,
      email: parsed.data.email ?? null,
      exp: parsed.data.exp,
    };
  } catch {
    return null;
  }
}
