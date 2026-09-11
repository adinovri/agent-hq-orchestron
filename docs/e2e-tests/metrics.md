# Metrics — E2E Test Plan

`/metrics` — the cost page: four summary tiles, a daily cost chart, a
per-project breakdown, a per-session table, and a date range over all
four.

The page is a thin view over `GET /api/metrics`. Nearly everything
worth testing is in the endpoint's arithmetic, so most scenarios here
assert the UI **and** the number behind it, and one (`METRICS-05`)
leaves the UI entirely because the page cannot reach the axis it tests.

Spec: [USAGE.md § Metrics](../USAGE.md#metrics) · endpoint arithmetic in
`apps/api/src/domain/metrics-collector.ts`, whose header comment is the
authority on dedup and per-event pricing.

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **Sessions with real usage, across at least two projects.** The
  collector **skips any session whose four token counters are all
  zero**, so a freshly-spawned-and-killed session is invisible here. A
  couple of completed `e2e-haiku` turns plus one on another fixture is
  enough.
- **At least one headless session.** The dedup case (`METRICS-02`) only
  arises on the headless path, where nearly every turn splits into a
  thinking row and a text row.

```bash
. ~/.orchestron-e2e/e2e.env
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/metrics?groupBy=session" \
  | python3 -m json.tool | head -40
```

> **The two cost numbers are not the same number and are not meant to
> be.** A session record's `costUsd` sums the harness's own
> `total_cost_usd` per `-p` envelope; `/api/metrics` prices the rollout
> JSONL with Orchestron's rate table. Do not write a scenario that
> asserts they match. See [`session-details.md`](session-details.md) for
> the measured spread and the caveat about which figure to trust.

---

## Scenarios

### METRICS-01 — Summary tiles and the range they describe `[smoke]`

**Covers**: the four tiles, their formatting, and that they describe the
selected range rather than all of history. First thing anyone looks at,
and the tile values are what get quoted in a budget conversation.

**Steps**

1. Open `$ORCH_WEB/metrics`.
2. Read the subtitle under the heading and the four tiles.
3. Compare against the endpoint for the same range:

   ```bash
   FROM=$(date -u -d '30 days ago' +%F); TO=$(date -u +%F)
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/metrics?groupBy=day&from=$FROM&to=$TO" \
     | python3 -c 'import json,sys;t=json.load(sys.stdin)["total"];print(t)'
   ```

4. Narrow the range with the date picker to **today only** and re-read
   the tiles.

**Expect**

- Subtitle reads `<from> → <to>`; the default range is **the last 30
  days**, i.e. today minus 30 through today, both `YYYY-MM-DD`.
- Tiles, left to right: **Sessions**, **Tokens**, **Cost**, **Avg
  duration**.
- `Sessions` equals `total.sessions`; `Cost` equals
  `$` + `total.cost_usd` to **two decimals**; `Tokens` renders as
  `<n>` below 1000 and `<n/1000 to 1dp>k` at or above it — so `18 171`
  shows as `18.2k`.
- `Avg duration` is a **session-weighted** mean across day buckets,
  rendered `<n>s` under a minute and `<n.n>m` at or above. With no
  sessions in range it is an em dash `—`, not `0s`.
- While the query is in flight each tile shows a skeleton, not a zero.
  A tile that shows `0` or `$0.00` briefly and then the real value is a
  regression worth reporting — zeros read as fact.
- After step 4 every tile changes (or the range is genuinely empty, in
  which case `METRICS-04` applies).

**📷 Screenshot**: `metrics-01-tiles.png` — subtitle and all four tiles.

**Cleanup**: none.

---

### METRICS-02 — A split assistant message is billed once

**Covers**: the NF9 defect and its fix (`bea9327`) — Claude Code writes
one assistant message as **two** rollout rows when the response carries
a `thinking` block: same `message.id`, same `usage` object. Summing both
billed every such turn twice; on the headless path that came out at
**exactly 2×**.

**Steps**

1. Pick a headless session that has run at least two turns.
2. Find its rollout and count the split rows:

   ```bash
   JSONL=$(curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions/<uuid>" \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["jsonlPath"])')

   python3 - "$JSONL" << 'PY'
   import json,sys,collections
   ids=collections.Counter(); naive=0; dedup={}
   for line in open(sys.argv[1]):
       line=line.strip()
       if not line: continue
       try: ev=json.loads(line)
       except ValueError: continue
       m=ev.get("message") or {}
       u=m.get("usage")
       if ev.get("type")!="assistant" or not u: continue
       tot=sum(u.get(k,0) for k in
               ("input_tokens","output_tokens",
                "cache_read_input_tokens","cache_creation_input_tokens"))
       naive+=tot
       mid=m.get("id")
       ids[mid]+=1
       if mid not in dedup: dedup[mid]=tot
   print("rows        ", sum(ids.values()))
   print("unique ids  ", len(ids))
   print("dup rows    ", sum(ids.values())-len(ids))
   print("naive tokens", naive)
   print("dedup tokens", sum(dedup.values()))
   PY
   ```

3. Read the same session's tokens from the endpoint:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/metrics?groupBy=session" \
     | python3 -c '
   import json,sys
   for b in json.load(sys.stdin)["buckets"]:
       print(b["key"], b["tokens"], b["cost_usd"])'
   ```

4. Find that session's row in the **Per-Session Cost** table on the page
   and compare.

**Expect**

- `dup rows` is **greater than zero** on a headless session with
  thinking blocks. If it is zero the session cannot test anything here
  — pick another, or record a skip with that reason. Whether a turn
  splits is decided by **the model choosing to emit a thinking block**,
  not by the session's mode: a tmux Opus session may have none and a
  tmux Haiku session may have many.
- The endpoint's `tokens` for that session equals **`dedup tokens`**,
  exactly.
- It does **not** equal `naive tokens`. Where every turn split, naive
  is exactly 2× dedup.
- The page's table row agrees with the endpoint for the same session.
- Cross-check the aggregations: `groupBy=day`, `project`, `adapter` and
  `session` all report the **same** `total.tokens` and
  `total.cost_usd`. Dedup happens per session before grouping, so a
  divergence between axes means the dedup moved, not the grouping.

**Cleanup**: none.

---

### METRICS-03 — Each event is priced at its own model

**Covers**: the NF10 defect and its fix (same commit) — cost used to be
the whole session's token total multiplied by the rate of the **last**
billed event's model. A session that changed model mid-way priced every
earlier token at the final rate: up to 5× (opus↔sonnet) or 18.75×
(opus↔haiku) out, in either direction.

**Steps**

1. Produce a mixed-model session the cheap way — spawn on `e2e-haiku`,
   run one turn, then use the pencil dialog
   ([`metadata-edit.md`](metadata-edit.md) `META-01`) to switch the
   model, then run a second turn.
2. Confirm the rollout really carries two models:

   ```bash
   python3 -c '
   import json,sys,collections
   c=collections.Counter()
   for line in open(sys.argv[1]):
       try: ev=json.loads(line)
       except ValueError: continue
       m=ev.get("message") or {}
       if ev.get("type")=="assistant" and m.get("usage"):
           c[m.get("model")]+=1
   print(c)' "$JSONL"
   ```

3. Compute the expected cost per event with the rate table in
   `apps/api/src/domain/pricing-table.ts`, dedup by `message.id` first.
4. Compare with the endpoint's `cost_usd` for that session, and with
   the page's table row.

**Expect**

- Step 2 shows **two distinct model strings**, each with a non-zero row
  count. Without that this scenario cannot run — skip it with that
  reason rather than asserting on a single-model session.
- The endpoint's `cost_usd` equals the **sum of per-event costs**, each
  at its own event's model.
- It does **not** equal `total tokens × final model rate`. State both
  figures in the report; the ratio between them is the size of the bug
  this guards.
- An event whose row omits `message.model` is priced at the **session's**
  recorded model. An event whose model names no entry in the rate table
  falls back to `DEFAULT_PRICING` (Sonnet rates) — note it if seen,
  because on a Haiku session that silently overcharges.
- **`groupBy=model` attribution is deliberately coarser than the
  pricing.** The bucket key is the session's *last* billed model, so a
  mixed-model session lands wholly in one bucket while its cost is
  summed per event. Attribution and money are answering different
  questions; this is not a bug to file.

**Cleanup**: kill and delete the session created in step 1.

---

### METRICS-04 — Empty range and empty sections

**Covers**: four distinct empty states, which are easy to regress into
zeros or blank boxes.

**Steps**

1. Set the date range to a window with no activity — e.g. `from` and
   `to` both `2020-01-01`.
2. Read the tiles and all three sections.
3. Confirm the endpoint agrees:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/metrics?groupBy=day&from=2020-01-01&to=2020-01-01" \
     | python3 -m json.tool
   ```

4. Reject a few bad ranges:

   ```bash
   for q in 'groupBy=nope' 'from=01-01-2020' 'from=2026-09-11&to=2026-09-01'; do
     echo -n "$q → "
     curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
       "$ORCH/api/metrics?$q"
   done
   ```

**Expect**

- Endpoint returns `{"buckets": [], "total": {...zeros}}` — **200 with
  an empty list**, not 404 and not an error.
- `Sessions`, `Tokens` and `Cost` read `0`, `0` and `$0.00`; **`Avg
  duration` reads `—`**, because a mean of nothing is not zero.
- **Daily Cost** shows `No sessions in this range`.
- **Per-Project Breakdown** shows `No project activity in this range`.
- **Per-Session Cost** renders its own component with an empty list —
  note what it actually shows. Unlike the two above, this section has no
  early-return empty branch on the page; an empty table with headers is
  the expected outcome, a blank white box is a finding.
- All three bad ranges return **400** with a message naming the
  offending parameter: an invalid `groupBy` lists the five valid values,
  a malformed date says `expected YYYY-MM-DD`, and a reversed range says
  `"from" must not be after "to"`.

**📷 Screenshot**: `metrics-04-empty.png` — tiles plus all three empty
sections.

**Cleanup**: reset the range to the default.

---

### METRICS-05 — The five grouping axes (API only)

**Covers**: `groupBy` — the endpoint supports **five** axes and the page
requests only three of them, on fixed queries, with no control to
change them. This scenario exists to cover the two the UI can never
reach, and to pin that gap so it is a decision rather than an oversight.

**Steps**

1. Query all five axes over the same range:

   ```bash
   for g in day project adapter model session; do
     echo "── $g"
     curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/metrics?groupBy=$g" \
       | python3 -c '
   import json,sys
   d=json.load(sys.stdin)
   print("  total", d["total"])
   for b in d["buckets"][:6]:
       print("  ", b["key"], b["sessions"], b["tokens"], round(b["cost_usd"],6))'
   done
   ```

2. Apply the two filters:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/metrics?groupBy=day&projectId=$E2E_PROJECT_HAIKU" | python3 -m json.tool | head
   curl -s -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/metrics?groupBy=day&adapter=claude" | python3 -m json.tool | head
   curl -s -o /dev/null -w 'bad adapter → %{http_code}\n' -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/metrics?groupBy=day&adapter=gemini"
   ```

3. Open `$ORCH_WEB/metrics` and look for any control that changes the
   grouping.

**Expect**

- All five axes return 200. `total` is **identical across all five** —
  same `sessions`, same `tokens`, same `cost_usd` — because grouping
  only re-keys the same per-session rows.
- Bucket keys are: `YYYY-MM-DD` for `day`; a **project uuid** for
  `project` (the page maps it to a name, the endpoint does not); one of
  `claude` / `codex` / `opencode` for `adapter`; a model string for
  `model`; a **session uuid** for `session`.
- `projectId` and `adapter` narrow the result; `total` drops
  accordingly. An unknown `adapter` returns **400** listing the three
  valid values. An unknown `projectId` returns **200 with empty
  buckets** — it is a filter, not a lookup.
- No bucket key is `<synthetic>`. Resume-machinery rows carry
  `"model":"<synthetic>"` with all-zero usage; they must not become an
  attribution bucket. See the note below.
- **The page has no grouping control.** It issues exactly three fixed
  queries — `groupBy=day`, `groupBy=project`, `groupBy=session` — and
  `adapter` and `model` have **no UI surface at all**. Assert the
  absence: there is no select, no tab row and no segmented control on
  the page that changes `groupBy`. If one appears, this scenario and the
  `Covers` line above both need rewriting.

**Cleanup**: none.

---

## Notes for scenario authors

- **All-zero sessions are invisible here, by construction.** The
  collector drops any session whose four counters are all zero, so
  "session count on /metrics" and "card count on the dashboard" are
  different numbers and a scenario asserting they match is wrong.
- **`<synthetic>` is not a model.** Claude Code writes the resume reply
  *"No response requested."* as an assistant row with
  `"model":"<synthetic>"` and an all-zero `usage`. Such a row is
  ignored for attribution and priced at the session's model if it ever
  carries usage, so it can neither create a `<synthetic>` bucket nor
  drag a Haiku session onto Sonnet rates. That guard is what NF12 asked
  for; before it, the only thing preventing a `<synthetic>` bucket was
  the injected pair landing *before* each new turn, i.e. ordering luck.
- **The duplicate-usage warning is per query, not per session.** Rows
  sharing a `message.id` with **different** numbers log a
  `console.warn` on **every** `/api/metrics` request, so one bad rollout
  row produces a warn per query for as long as it exists. Noisy, not
  wrong — do not read repeated warns as repeated defects.
- **Codex sessions have no cost.** The rate table carries Claude tiers
  only, because ChatGPT Plus/Pro/Enterprise is flat-rate bundled. Treat
  codex rows as N/A, **not** `$0` — asserting `$0.0000` on a codex
  session asserts the wrong thing.
- **Cost of running this file.** `METRICS-03` is the only scenario that
  must spend anything, and two Haiku turns cover it. Everything else
  reads sessions other files already made. Do **not** reach for Opus to
  produce a mixed-model session: the pencil dialog gets you two models
  for two cheap turns.
