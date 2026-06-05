import { sign, verify } from "hono/jwt";
import type { DeviceUser } from "./deviceStore.js";

const TOKEN_TTL_SEC = 60 * 60;

// Bind access tokens to a specific issuer + audience so that another artifact signed with
// the same JWT_SECRET (e.g. the OAuth `state` token in routes/auth.ts) can never be
// replayed as an access token. hono's verify checks the signature/alg/exp but NOT iss/aud,
// so we assert those ourselves below.
export const TOKEN_ISSUER = "vibi-auth";
export const ACCESS_AUDIENCE = "vibi-access";

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  exp: number;
  iss: string;
  aud: string;
  [key: string]: unknown;
}

export interface IssuedToken {
  accessToken: string;
  expiresAt: number;
  user: DeviceUser;
}

function getSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not set");
  return secret;
}

export async function issueToken(user: DeviceUser): Promise<IssuedToken> {
  const expSec = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const payload: AccessTokenPayload = {
    ...user,
    exp: expSec,
    iss: TOKEN_ISSUER,
    aud: ACCESS_AUDIENCE,
  };
  const accessToken = await sign(payload, getSecret());
  return { accessToken, expiresAt: expSec * 1000, user };
}

export async function verifyToken(token: string): Promise<AccessTokenPayload> {
  const payload = (await verify(token, getSecret(), "HS256")) as unknown as AccessTokenPayload;
  // hono verifies signature/alg/exp; we must check issuer + audience ourselves so a token
  // minted for another purpose (same secret) can't pass as an access token.
  if (payload.iss !== TOKEN_ISSUER || payload.aud !== ACCESS_AUDIENCE) {
    throw new Error("token issuer/audience mismatch");
  }
  return payload;
}
