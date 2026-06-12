import { BFF_BASE_URL } from "../config";
import { authHeader } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { readJson } from "./http";

export class InsufficientCreditsError extends Error {
  constructor(public required: number, public balance: number) {
    super(`Insufficient credits: need ${required}, have ${balance}`);
    this.name = "InsufficientCreditsError";
  }
}

export async function getBalance(): Promise<number> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/credits`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`credits failed: ${check401(res.status)}`);
  const data = await readJson<{ balance: number }>(res, "credits");
  return data.balance;
}

export interface CreditPack {
  id: string;
  credits: number;
  priceCents: number;
  label: string;
}

export async function getPacks(): Promise<{ packs: CreditPack[]; currency: string }> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/credits/packs`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`packs failed: ${check401(res.status)}`);
  return readJson<{ packs: CreditPack[]; currency: string }>(res, "packs");
}

export async function createCheckout(packId: string): Promise<string> {
  const res = await fetch(`${BFF_BASE_URL}/api/v2/credits/checkout`, {
    method: "POST",
    headers: { ...(await authHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ packId }),
  });
  if (!res.ok) throw new Error(`checkout failed: ${check401(res.status)}`);
  const data = await readJson<{ url: string }>(res, "checkout");
  return data.url;
}

export async function throwIfInsufficient(res: Response): Promise<void> {
  if (res.status !== 402) return;
  const data = (await res.json().catch(() => ({}))) as { required?: number; balance?: number };
  throw new InsufficientCreditsError(data.required ?? 0, data.balance ?? 0);
}
