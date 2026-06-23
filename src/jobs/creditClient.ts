import { BFF_BASE_URL } from "../config";
import { authHeader } from "../auth/tokenStore";
import { check401 } from "../auth/session";
import { fetchWithTimeout, readJson } from "./http";

export class InsufficientCreditsError extends Error {
  constructor(public required: number, public balance: number) {
    super(`Insufficient credits: need ${required}, have ${balance}`);
    this.name = "InsufficientCreditsError";
  }
}

export async function getBalance(): Promise<number> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/credits`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`credits failed: ${check401(res.status)}`);
  const data = await readJson<{ balance: number }>(res, "credits");
  return data.balance;
}

// NOTE: 플러그인에는 자체 결제(Paddle)를 두지 않는다. 크레딧 충전은 vibi 모바일 앱(IAP)에서 하고,
// 같은 계정으로 로그인하면 공유 DB 의 동일 잔액을 여기서 그대로 소비한다(getBalance 가 그 잔액).
// 따라서 packs/checkout 호출은 제거했다(BFF 도 플러그인용 결제 엔드포인트를 서빙하지 않음).

export async function throwIfInsufficient(res: Response): Promise<void> {
  if (res.status !== 402) return;
  const data = (await res.json().catch(() => ({}))) as { required?: number; balance?: number };
  throw new InsufficientCreditsError(data.required ?? 0, data.balance ?? 0);
}
