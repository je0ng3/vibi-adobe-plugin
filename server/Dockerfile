# vibi-adobe-plugin server — Node 22 / Hono / ffmpeg.
# tsx 로 TS 를 직접 실행(빌드 산출물 없음, tsconfig noEmit) 하므로 별도 컴파일 스테이지 없음.
# src 의 .ts 를 런타임에 그대로 import → devDependency 인 tsx 도 이미지에 포함해야 함(= 전체 npm ci).
#
# ffmpeg/ffprobe: util/mix.ts, util/segment.ts 가 spawn 하므로 런타임 필수.
# 외부 의존성(Neon Postgres / Perso / Paddle)은 그대로 재사용 — 컴퓨트만 Oracle 로.

# LTS 핀(bookworm) — slim 으로 이미지 축소, ffmpeg 만 apt 로 추가.
FROM node:22-bookworm-slim

# ffmpeg / ffprobe — 오디오 믹스/세그먼트 런타임 필수. ca-certificates — Perso/Paddle/Google HTTPS.
# 한 RUN 으로 묶어 레이어 최소화, apt 캐시 즉시 제거.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) manifest 먼저 — 의존성 변경 시에만 이 레이어 무효화(캐시 hit 극대화).
COPY package.json package-lock.json ./
# tsx(devDep)가 런타임에 필요하므로 --omit=dev 금지. ci 로 lockfile 정확 재현.
RUN npm ci

# 2) 소스 — 자주 변경됨. tsx 가 .ts 를 직접 실행하므로 빌드 단계 없음.
COPY tsconfig.json ./
COPY src src

# 비루트 실행(node 이미지의 기본 'node' uid=1000 사용). STEM 작업 디렉터리는 tmpfs(/tmp) 로.
ENV NODE_ENV=production
ENV PORT=8787
ENV STEM_DIR=/tmp/stems
USER node
EXPOSE 8787

# package.json 의 start 와 동일하되 .env 는 compose env_file 로 주입하므로 --env-file 생략.
ENTRYPOINT ["node", "--import", "tsx/esm", "src/index.ts"]
