# vibi-adobe-plugin server — Oracle Cloud Always Free 배포

Premiere Pro 플러그인의 백엔드(Hono/Node). **vibi-bff 와 완전히 별개의 VM/스택**으로
Oracle Ampere(ARM) VM 에 독립 배포. 상시기동·TLS·재시작·방화벽만 이 디렉터리에서 wire.

외부 의존성(관리형 Postgres / Perso / Paddle)은 **그대로 재사용** — 컴퓨트만 Oracle 로.

```
../../Dockerfile     Node22 + ffmpeg, tsx 로 src/.ts 직접 실행 (빌드 산출물 없음)
docker-compose.yml   server(Hono) + caddy(자동 HTTPS) 2 컨테이너, 둘 다 restart: always
Caddyfile            plugin-api.vibi.fm → server:8787 리버스 프록시, Let's Encrypt 자동 TLS
plugin.env.example   VM 런타임 env 템플릿 → plugin.env 로 복사해 채움 (gitignored)
setup-firewall.sh    함정1 방지 — VM iptables 80/443 영구 허용
```

도메인: **`plugin-api.vibi.fm`** (BFF 는 `api.vibi.fm` — 서로 다른 서브도메인, 다른 VM).

---

## 두 함정, 영구 차단 (BFF 와 동일)

### 함정 1 — iptables (방화벽 이중 구조)
콘솔(Security List)과 VM 내부(iptables) **두 겹 다** 열어야 함:

1. **콘솔**: VCN → Security List → Ingress Rules → Source `0.0.0.0/0`, TCP, Dest Port `80`,`443`
2. **VM 내부**: `./setup-firewall.sh` (iptables 삽입 + `netfilter-persistent save` 영구화)

### 함정 2 — Always Free 인스턴스 회수
유휴 ARM 인스턴스만 회수 대상. **PAYG 업그레이드 시 회수 면제 — 비용은 여전히 $0**.
운영 서비스면 필수: 콘솔 → Billing → Upgrade to Pay As You Go.
`restart: always` 는 reboot/크래시 복구용 안전망 (회수 자체는 PAYG 가 본 해법).

---

## 셋업 순서

1. **인스턴스 생성** — Ampere A1 (Always Free), Ubuntu 22.04, public IP 할당
   (BFF 와 같은 계정이면 **별도 VM** 으로 — 두 서버가 각각 80/443 을 점유하므로 한 VM 공유 불가)
2. **PAYG 업그레이드** (함정 2)
3. **콘솔 Security List 80/443 오픈** (함정 1 바깥 겹)
4. **도메인 A 레코드** `plugin-api.vibi.fm` → 이 VM public IP (TLS 자동 발급에 필요)
5. SSH 접속 후:
   ```bash
   sudo apt-get update && sudo apt-get install -y docker.io docker-compose-v2 iptables-persistent git
   sudo usermod -aG docker $USER && newgrp docker
   git clone <repo> vibi-adobe-plugin && cd vibi-adobe-plugin/server/deploy/oracle
   ./setup-firewall.sh                          # 함정 1 안쪽 겹
   cp plugin.env.example plugin.env && vim plugin.env   # 시크릿 채우기 (로컬 server/.env 값 + prod 항목)
   docker compose up -d --build                 # 첫 빌드 (ARM 네이티브)
   docker compose logs -f server
   ```
6. **검증**: `curl -i https://plugin-api.vibi.fm/healthz` → `{"ok":true}` 200, 인증서 정상
7. **외부 콘솔 등록**:
   - Google OAuth redirect URI: `https://plugin-api.vibi.fm/api/v2/auth/google/callback`
   - Paddle webhook 대상: `https://plugin-api.vibi.fm` 의 Paddle 라우트
8. **플러그인 빌드/패키징**: 패널이 이 서버를 가리키도록 base URL 주입 후 빌드 —
   ```bash
   cd ../../..                                  # = vibi-adobe-plugin 루트
   VIBI_BFF_BASE_URL=https://plugin-api.vibi.fm npm run build && npm run package
   ```
   (manifest 의 network 도메인은 이미 `https://plugin-api.vibi.fm` 로 등록돼 있음.)

> server 는 Postgres 스키마를 부팅 시 `ensureSchema()` 로 보장하므로 별도 마이그레이션 불필요.
> stem 작업 파일은 컨테이너 tmpfs(`/tmp/stems`) 에만 쓰고 cleanup sweep 이 TTL 후 정리 —
> VM 디스크에 영속 안 함.
