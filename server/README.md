# vibi-adobe-plugin server

Adobe Premiere Pro UXP 플러그인 전용 mini backend. **Node + Hono + TypeScript**, 빌드 단계 없이 `tsx` 로 `.ts` 를 직접 실행합니다. vibi-bff 와는 **완전히 별개의 스택**이며 자체 Perso · Postgres · R2 · Paddle 자격증명을 사용합니다 (BFF 코드 재사용 안 함).

## 역할

- **음원 분리** — 오디오 업로드 → Perso audio-separation → 화자별 stem (`speaker_0..N`) + `voice_all` + `background`.
- **STT 대본** — Perso speech-to-text + 화자 분리(diarization) → 편집 가능한 `ScriptDraft`.
- **크레딧 / 결제** — 분당 과금(최소 1크레딧), 잔액 조회 + **Paddle** 체크아웃.
- **파형(peaks)** — 타임라인 스크러빙용 waveform 데이터.
- 더빙/자막 생성은 제공하지 않습니다.

## 구성

```
src/
├── index.ts                  # Hono 엔트리 + ensureSchema() (Postgres 스키마 자동 보장)
├── routes/
│   ├── auth.ts               # /auth/device/{start,poll} · /auth/google/{start,callback} (device code + Google OAuth)
│   ├── separation.ts         # /separate · /separations · /separate/{id}(/stem/{stemId}) · /separate/{id}/script
│   ├── credits.ts            # /credits · /credits/cost
│   ├── paddle.ts             # /credits/packs · /credits/checkout (Paddle)
│   ├── peaks.ts              # /peaks (waveform)
│   ├── devicePage.ts         # /device (브라우저 device-code 승인 페이지)
│   └── health.ts             # /healthz
└── jobs/
    ├── separationJob.ts      # Perso 분리 오케스트레이션 (upload → submit → poll → stem 다운로드 → WAV)
    ├── transcriptJob.ts      # Perso STT → ScriptDraft 조립
    ├── jobQueue.ts           # Perso 호출 동시성 게이트
    ├── jobStore.ts           # 잡 상태 테이블 (Postgres)
    ├── stemStore.ts          # stem 바이트 저장 (R2 또는 로컬 /tmp/stems)
    ├── objectStore.ts        # R2 SigV4 presigner
    ├── artifacts.ts          # 분리 산출물 정리
    └── cleanup.ts            # 방치된 결과 TTL sweep
```

## 외부 의존

| 서비스 | 용도 | env |
|---|---|---|
| **Perso** | 음원 분리 + STT | `PERSO_API_KEY`, `PERSO_SPACE_SEQ` |
| **Postgres** | 사용자 / 잡 / 크레딧 | `DATABASE_URL` |
| **Cloudflare R2** (옵션) | stem 다운로드 presigned URL | `R2_BUCKET`, `R2_ACCOUNT_ID`, R2 키 |
| **Paddle** | 크레딧 결제 검증 | Paddle 키 |
| **Google OAuth** | device-code 사용자 승인 | OAuth client id/secret |

인증은 **device code flow**(브라우저에서 Google 로그인 → 코드 승인) + **JWT(ES256)** 발급입니다.

## 실행

```bash
cp .env.example .env
npm install
npm run dev
```

`GET http://localhost:8787/healthz` → `{"ok":true}`

## 배포

GCP Compute Engine(e2-micro) + Caddy 리버스 프록시로 운영합니다. 도메인은 BFF(`api.vibi.fm`)와 분리된 `plugin-api.vibi.fm` 입니다. 상세는 [`deploy/gcp/README.md`](./deploy/gcp/README.md) 참조.
