# vibi-adobe-plugin server — GCP Compute Engine (e2-micro Free Tier) 배포

Premiere Pro 플러그인의 백엔드(Hono/Node). **vibi-bff 와 완전히 별개의 VM/스택**으로
GCP Compute Engine VM 에 독립 배포. 상시기동·TLS·재시작·방화벽만 이 디렉터리에서 wire.

외부 의존성(관리형 Postgres / Perso / Paddle / R2)은 **그대로 재사용** — 컴퓨트만 GCP 로.
서버 ffmpeg 는 transcode(분리 스템→WAV) + peaks(파형 디코드)만 — mix/segment 는 패널 pure-JS 로
이관됐고 워크로드가 idle-heavy 라 **e2-micro 무료 한도로 충분**.

```
../../Dockerfile     Node22 + ffmpeg, tsx 로 src/.ts 직접 실행 (빌드 산출물 없음)
docker-compose.yml   server(Hono) + caddy(자동 HTTPS) 2 컨테이너, 둘 다 restart: always
Caddyfile            plugin-api.vibi.fm → server:8787 리버스 프록시, Let's Encrypt 자동 TLS
plugin.env.example   VM 런타임 env 템플릿 → plugin.env 로 복사해 채움 (gitignored)
```

도메인: **`plugin-api.vibi.fm`** (BFF 는 `api.vibi.fm` — 서로 다른 서브도메인, 다른 VM).

---

## GCP 단 하나의 함정 — 고정 외부 IP

e2-micro 의 기본 외부 IP 는 **ephemeral** — VM 을 stop/start 하면 바뀐다. 그러면 A 레코드가
깨지고 TLS 도 무너지므로, **정적 외부 IP 를 예약**해 VM 에 붙여야 한다(예약 IP 는 실행 중인
VM 에 붙어있는 동안 무료).

방화벽은 OS iptables 가 아니라 **VPC 방화벽 규칙**으로 연다(Oracle 의 호스트 iptables 이중구조는
GCP 엔 불필요 — Debian/Ubuntu 이미지가 호스트 레벨 차단을 안 건다). Oracle 의 'Always Free
인스턴스 회수' 함정도 GCP e2-micro 엔 없다.

---

## 셋업 순서 (콘솔 + SSH)

1. **정적 외부 IP 예약** — 콘솔 → VPC network → IP addresses → *Reserve external static address*
   (region 은 VM 과 동일. 무료 한도 region 은 `us-west1`/`us-central1`/`us-east1` 중 하나)
2. **인스턴스 생성** — 콘솔 → Compute Engine → Create instance
   - Machine type **e2-micro**, region 은 위 IP 와 동일
   - Boot disk: Debian 12 또는 Ubuntu 22.04, **30GB standard**(무료 한도)
   - Networking → External IP = 위에서 예약한 정적 IP
   - **Firewall: "Allow HTTP traffic" + "Allow HTTPS traffic" 체크** (GCP 가 80/443 VPC 규칙 +
     `http-server`/`https-server` 태그를 자동 생성 — 별도 방화벽 작업 불필요)
   - (BFF 와 같은 프로젝트여도 **별도 VM** 으로 — 두 서버가 각각 80/443 을 점유)
3. **도메인 A 레코드** `plugin-api.vibi.fm` → 예약한 정적 IP (TLS 자동 발급에 필요)
4. **배포** — 아래 *자동 배포 (CD)* 의 one-time 셋업(SSH 키 + secrets)을 한 번 하면, 이후
   docker 설치·코드 전송·`docker compose up` 까지 GitHub Actions 가 전부 자동 처리한다.
   (수동으로 한 번 띄우려면 *수동 배포 (fallback)* 참고.)
5. **검증**: `curl -i https://plugin-api.vibi.fm/healthz` → `{"ok":true}` 200, 인증서 정상
6. **외부 콘솔 등록** (도메인 유지 시 기존 값 그대로면 생략 가능):
   - Google OAuth redirect URI: `https://plugin-api.vibi.fm/api/v2/auth/google/callback`
   - Paddle webhook 대상: `https://plugin-api.vibi.fm` 의 Paddle 라우트
7. **플러그인 재빌드 — 도메인이 동일하면 불필요**. 호스트만 GCP 로 바뀌고 도메인을 유지하면
   기존 패키지를 그대로 쓴다. 도메인을 바꾸는 경우에만:
   ```bash
   cd ../../..                                  # = vibi-adobe-plugin 루트
   VIBI_BFF_BASE_URL=https://plugin-api.vibi.fm npm run build && npm run package
   ```
   (manifest 의 network 도메인은 이미 `https://plugin-api.vibi.fm` 로 등록돼 있음.)

> server 는 Postgres 스키마를 부팅 시 `ensureSchema()` 로 보장하므로 별도 마이그레이션 불필요.
> stem 작업 파일은 컨테이너 tmpfs(`/tmp/stems`) 에만 쓰고 cleanup sweep 이 TTL 후 정리 —
> VM 디스크에 영속 안 함.

## 자동 배포 (CD)

`.github/workflows/deploy-gcp.yml` 가 main 푸시(server/** 경로) 시 **부트스트랩+배포를 전부 자동**으로
한다. 레포가 private 이라 VM 이 GitHub 에서 클론하지 않고, **Action 러너가 코드를 rsync 로 VM 에
밀어넣고** plugin.env 는 secret 에서 생성한다 — VM 엔 GitHub 자격증명이 필요 없다.

흐름: checkout → SSH 키 준비 → plugin.env 를 `PLUGIN_ENV` secret 으로 생성 → (없으면 rsync/docker
설치) → 코드 rsync → `docker compose up -d --build` → healthz 확인.

**one-time 셋업:**
1. CI 용 SSH 키페어 생성: `ssh-keygen -t ed25519 -f deploy_key -N ""`
2. **공개키**(`deploy_key.pub`)를 VM 에 등록: 콘솔 → VM → Edit → SSH Keys → Add item
   (키에 박힌 username 이 `DEPLOY_SSH_USER` 가 된다)
3. repo secrets 등록 (Settings → Secrets and variables → Actions):
   - `DEPLOY_SSH_HOST` — 정적 IP 또는 `plugin-api.vibi.fm`
   - `DEPLOY_SSH_USER` — SSH 사용자(키 username 과 동일)
   - `DEPLOY_SSH_KEY` — **개인키**(`deploy_key` 전체 내용)
   - `PLUGIN_ENV` — `plugin.env` 파일 전체 내용(모든 시크릿) ← single source of truth
   - (선택) `DEPLOY_SSH_PORT`(기본 22), `DEPLOY_PATH`(기본 `~/vibi-adobe-plugin`)

이후엔 main 에 push 하거나 Actions 탭에서 *Run workflow* 만 누르면 배포된다. env 를 바꿀 땐
`PLUGIN_ENV` secret 만 수정하면 다음 배포에 반영된다(VM 에서 직접 편집 불필요).

## 수동 배포 (fallback)

CD 없이 한 번 띄우려면 SSH 접속 후:
```bash
sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 git
sudo usermod -aG docker $USER && newgrp docker
git clone <repo> vibi-adobe-plugin && cd vibi-adobe-plugin/server/deploy/gcp
cp plugin.env.example plugin.env && vim plugin.env   # 또는 로컬 plugin.env 를 scp
docker compose up -d --build && docker compose logs -f server
```
