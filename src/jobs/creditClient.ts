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

export interface CreditStatus {
  /** 이 계정의 크레딧 잔액. */
  balance: number;
  /**
   * 서비스(Perso 계정) quota 가용 여부 — 사용자 개인 잔액과 무관한 전역 상태. 잔여가 BFF
   * 예비분 임계값 이하로 떨어지면 false 이고, 이때 새 분리 요청은 확정적으로 실패한다(그 전에
   * 크레딧만 선차감될 수 있음). 그래서 패널은 공지를 띄우고 분리 시작을 막는다.
   * 구 BFF 응답에는 이 필드가 없으므로 default true (fail-open).
   */
  separationAvailable: boolean;
}

export async function getCredits(): Promise<CreditStatus> {
  const res = await fetchWithTimeout(`${BFF_BASE_URL}/api/v2/credits`, { headers: await authHeader() });
  if (!res.ok) throw new Error(`credits failed: ${check401(res.status)}`);
  const data = await readJson<{ balance: number; separationAvailable?: boolean }>(res, "credits");
  return { balance: data.balance, separationAvailable: data.separationAvailable !== false };
}

// NOTE: 플러그인에는 자체 결제(Paddle)를 두지 않는다. 크레딧 충전은 vibi 모바일 앱(IAP)에서 하고,
// 같은 계정으로 로그인하면 공유 DB 의 동일 잔액을 여기서 그대로 소비한다(getCredits 의 balance 가 그 잔액).
// 따라서 packs/checkout 호출은 제거했다(BFF 도 플러그인용 결제 엔드포인트를 서빙하지 않음).

export async function throwIfInsufficient(res: Response): Promise<void> {
  if (res.status !== 402) return;
  const data = (await res.json().catch(() => ({}))) as { required?: number; balance?: number };
  throw new InsufficientCreditsError(data.required ?? 0, data.balance ?? 0);
}
