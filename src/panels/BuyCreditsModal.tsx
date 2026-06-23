interface Props {
  onClose: () => void;
}

// 플러그인은 자체 결제를 두지 않는다 — 충전은 vibi 모바일 앱(IAP)에서. 같은 계정으로 로그인하면
// 공유 DB 의 동일 크레딧을 여기서 그대로 쓴다. 이 모달은 잔액 부족 시 그 안내만 보여준다.
export function BuyCreditsModal({ onClose }: Props) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Get credits</h3>
          <button className="file-card-remove" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="modal-sub">Credits are used to separate audio (1 credit ≈ 1 minute).</p>
        <p className="modal-sub">
          Top up in the <b>vibi mobile app</b>. Sign in with the same account and your credits are
          available here too.
        </p>
        <p className="modal-foot">Your balance refreshes here shortly after you top up.</p>
      </div>
    </div>
  );
}
