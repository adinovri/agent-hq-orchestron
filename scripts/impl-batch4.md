# Orchestron Implementation — Batch 4 (Web UI Complete)

Working dir: `~/Works/agent-hq-orchestron`. Direct-to-`main`.

## Referensi

- HLD: https://claude.ai/code/artifact/dd125bd7-3802-42fd-bf0b-81609817ef2d
- TASKS: https://claude.ai/code/artifact/357e72e5-40a9-4ded-9796-843a79a3ff55
- Prior batches summaries di `scratchpad/`

## State (post Batch 3)

- Backend: 100% done — semua API + streaming + hooks + templates + git host + metrics + snapshots + auth + PWA scaffold
- Web scaffold: Next.js 15 + shadcn UI + landing page
- Belum ada: dashboard, session detail, delegation DAG, metrics UI, pair/qr onboarding

## Batch 4 tasks (Web UI)

### 1. TASK-021 — Web Dashboard route

File: `apps/web/app/dashboard/page.tsx` + components `apps/web/components/{SessionCard,SessionList,FilterBar,SpawnDialog}.tsx`.

Behavior:
- React Query polling `/api/sessions` setiap 5s
- FilterBar: status (multi), project (dropdown), tags (multi), date range
- Fuzzy search on prompt/uuid
- Spawn button → SpawnDialog dgn form: pilih project + template dropdown + var fields (rendered from template frontmatter)
- Kill button di setiap card

Test skipped (E2E defer TASK-030). Fokus rendering + client state.

### 2. TASK-022 — Web Session Detail route

File: `apps/web/app/session/[uuid]/page.tsx` + `apps/web/components/{TranscriptPane,SessionHeader,KillConfirmDialog}.tsx`.

Behavior:
- SSE consumer via `EventSource` (auth token append `?token=<sessionStorage>` kalau remote mode)
- Transcript render: markdown dgn `react-markdown` + `remark-gfm` + `rehype-highlight`
- Virtualize long transcript via `react-virtuoso` atau simple max-lines cap
- Header: session UUID + status badge + adapter/model + started/ended timestamps
- Kill button dgn confirm modal (show descendant count via `/api/delegation/:uuid` query)
- Snapshot mode banner kalau session record `readOnly: true`

### 3. TASK-023 — Web Delegation DAG route

File: `apps/web/app/graph/page.tsx` + `apps/web/components/DelegationGraph.tsx`.

Behavior:
- Install `reactflow` + `dagre` (layout)
- Query `/api/delegation/:rootUuid` — return nodes + edges
- Auto-layout dagre (top-down)
- Node color coded by status (green: completed, red: failed, blue: running, gray: waiting)
- Click node → navigate ke `/session/<uuid>`
- Zoom + pan native react-flow
- URL param `?root=<uuid>` untuk pick root

### 4. TASK-024 — Web Metrics Dashboard

File: `apps/web/app/metrics/page.tsx` + `apps/web/components/{CostChart,ProjectBreakdown,DateRangePicker}.tsx`.

Behavior:
- Install `recharts`
- Query `/api/metrics?groupBy=day&from=X&to=Y` for time series
- Query `/api/metrics?groupBy=project` for breakdown
- Charts:
  - Daily cost line chart
  - Per-project bar chart
  - Total summary tile (tokens, cost, sessions count)
- Date range picker default: last 30 days
- Breakdown table sortable

### 5. TASK-025 — Web Pair/Onboarding route

File: `apps/web/app/pair/page.tsx`.

Behavior:
- Read `?token=` from URL query
- Store to `sessionStorage.orchestron_token`
- Global fetch interceptor: inject `Authorization: Bearer <token>` for `/api/*` — buat `apps/web/lib/fetcher.ts` yang wrap fetch, integrate ke React Query default fetcher
- Show PWA install prompt kalau `beforeinstallprompt` event fired
- Redirect ke `/dashboard` after 1s

Also update `apps/web/app/layout.tsx` — global navigation (Dashboard, Metrics, Graph, Settings), PWA install badge.

## Aturan main

- Direct-to-main
- Commit per task
- **Test skipped** untuk Web UI (E2E defer TASK-030), fokus feature correctness
- Selesai batch: push + summary + notify
- Script orchestrator auto-spawn batch 5 setelah summary muncul

Mulai TASK-021.
