import { useEffect, useState } from "react";
import { createCheckout, getPacks, type CreditPack } from "../jobs/creditClient";

interface Props {
  onClose: () => void;
  // Receives the Stripe Checkout URL to open in the system browser.
  onCheckout: (url: string) => void;
}

export function BuyCreditsModal({ onClose, onCheckout }: Props) {
  const [packs, setPacks] = useState<CreditPack[] | null>(null);
  const [currency, setCurrency] = useState("usd");
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    getPacks()
      .then((r) => {
        setPacks(r.packs);
        setCurrency(r.currency);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  async function buy(packId: string) {
    setError(null);
    setBusyId(packId);
    try {
      const url = await createCheckout(packId);
      onCheckout(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusyId(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Buy credits</h3>
          <button className="file-card-remove" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="modal-sub">Credits are used to separate audio (1 credit ≈ 1 minute).</p>

        {error && <sp-help-text variant="negative">{error}</sp-help-text>}
        {!packs && !error && <sp-help-text>Loading…</sp-help-text>}

        <div className="pack-list">
          {packs?.map((p) => (
            <button
              key={p.id}
              type="button"
              className="pack-row"
              disabled={busyId != null || undefined}
              onClick={() => buy(p.id)}
            >
              <span className="pack-credits">{p.credits} credits</span>
              <span className="pack-price">
                {busyId === p.id ? "Opening…" : formatPrice(p.priceCents, currency)}
              </span>
            </button>
          ))}
        </div>

        <p className="modal-foot">Checkout opens in your browser. Credits appear here once payment completes.</p>
      </div>
    </div>
  );
}

function formatPrice(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(
      cents / 100,
    );
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}
