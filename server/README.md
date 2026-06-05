# vibi-adobe-plugin server

Plugin 전용 mini backend. Node + Hono + TypeScript.

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

`GET http://localhost:8787/healthz` → `{"ok":true}`
