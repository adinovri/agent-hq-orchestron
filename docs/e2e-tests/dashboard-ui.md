# Dashboard — E2E Test Plan

The list view: stats, cards, ordering, filtering, project grouping,
delegation chips, status pills, and the bits of chrome that carry state
across reloads.

Spec: [USAGE.md § Dashboard tour](../USAGE.md#6-dashboard-tour) ·
[USAGE.md § Themes & appearance](../USAGE.md#7-themes--appearance) ·
[USAGE.md § Pairing & mobile](../USAGE.md#8-pairing--mobile)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **A populated dashboard.** Several scenarios need variety that a
  clean host does not have. Before starting, arrange at least:
  - sessions in **three or more distinct statuses**, including one
    `needs_input` and one terminal;
  - sessions across **at least two projects**;
  - one parent with **two children** (from
    [`mcp-spawn.md`](mcp-spawn.md) `MCP-02`);
  - at least one **tagged** project.

---

## Scenarios

### DASH-01 — Ordering is last-activity descending `[smoke]`

**Covers**: the sort key — `endedAt ?? startedAt`. Notably,
`needs_input` does **not** float to the top; it rises naturally because
a status transition updates the timestamps.

**Steps**

1. Note the current card order.
2. Send a turn into a session that is **not** currently first.
3. Reload and read the order again.
4. Find a `needs_input` session sitting mid-list and confirm it stays
   where its timestamp puts it.

**Expect**

- The session touched in step 2 moves to the top.
- Ordering holds identically in flat mode and within each group in
  grouped mode.
- The `needs_input` session is **not** pinned to the top. If a
  scenario author expects it to be, they are testing Tycho's behaviour,
  not orchestron's.

**📷 Screenshot**: `dash-01-order.png` — the list before and after
step 2.

**Cleanup**: none.

---

### DASH-02 — Stats grid

**Covers**: the four counters on the top row.

**Steps**

1. Read the *needs input* / *running* / *succeeded* / *failed* counts.
2. Count the matching cards by hand.
3. Archive one running session and re-read.

**Expect**

- Each counter matches the number of sessions in that status.
- The counts update after step 3 without a manual reload.

**Cleanup**: none.

---

### DASH-03 — Status pills

**Covers**: the pill for each state orchestron can be in, and the
palette that the Graph page reuses.

**Steps**

1. Collect one session in as many of these as you can reach:
   `spawning`, `waiting`, `running`, `needs_input`, `idle`, `sleeping`,
   `succeeded`, `failed`, `killed`.
2. Compare the pill on each card with the pill on that session's
   detail header.
3. Open Graph and compare node fills against the pills.

**Expect**

- Each status has a distinct, legible pill; none renders as raw text or
  an unstyled fallback.
- Card pill and detail-header pill agree for the same session.
- Graph node fill per status matches the pill palette.
- `spawning` and `waiting` are transient — catching them may need a
  slow prompt or a fast eye. Record them as skipped with a reason
  rather than guessing.

**📷 Screenshot**: `dash-03-status-pills.png` — as many distinct pills
in one frame as the host can produce.

**Cleanup**: none.

---

### DASH-04 — Project grouping and collapse persistence

**Covers**: the FolderTree view, and the two `localStorage` keys behind
it.

**Steps**

1. Click the **FolderTree** icon to group by project.
2. Collapse one project's group with its chevron.
3. Reload the page.
4. Click the **Rows** icon to go back to a flat list, then reload
   again.

**Expect**

- Grouped mode shows one collapsible header per project, each with its
  session counts.
- A **collapsed** group still surfaces urgency: its header keeps the
  counts, an **amber** chip for `needs_input` sessions and an
  **emerald** chip for active ones.
- After step 3 the group is **still collapsed** — persisted per project
  in `orchestron.dashboard.collapsedProjects`.
- After step 4 the view is **still flat** — persisted in
  `orchestron.dashboard.groupBy`.
- Ordering within each group follows `DASH-01`.

**📷 Screenshot**: `dash-04-collapsed-group.png` — a collapsed header
showing its counts and chips.

**Cleanup**: restore your preferred view.

---

### DASH-05 — Filter bar

**Covers**: all five filters, individually and combined.

**Steps**

1. **Status** — multi-select two statuses.
2. **Project** — pick one from the dropdown.
3. **Tag** — multi-select a tag.
4. **Date range** — set a window that excludes some sessions.
5. **Search** — type a fragment of a session's prompt, then a fragment
   of its id.
6. Combine status + project and confirm the intersection.
7. Clear everything.

**Expect**

- Status accepts more than one value and the list is their union.
- The project dropdown shows **names, not uuids**.
- Search matches on **both** prompt text and session id, fuzzily.
- Combined filters intersect rather than replacing one another.
- An empty result set renders a clear empty state, not a blank page.
- Clearing restores the full list.

**📷 Screenshot**: `dash-05-filters.png` — the bar with several filters
active and the filtered list beneath it.

**Cleanup**: clear all filters.

---

### DASH-06 — Session card content

**Covers**: what one card has to tell you at a glance.

**Steps**

1. Read a card end to end.
2. Compare each element against that session's detail page.

**Expect**

- The card carries: status pill, project chip (blue, **name** not
  uuid), harness chip (violet uppercase), a truncated prompt preview,
  and timestamps.
- A **Headless** badge appears where the mode and liveness rules say it
  should — see [`feature-flag.md`](feature-flag.md) `FLAG-07`.
- Delegation chips appear per [`mcp-spawn.md`](mcp-spawn.md) `MCP-02`.
- Every element matches the detail page.
- A session whose project has been **deleted** shows the raw project
  uuid instead of a name, and does not crash the card.

**📷 Screenshot**: `dash-06-card.png` — one fully-populated card.

**Cleanup**: none.

---

### DASH-07 — Split Spawn button

**Covers**: the header's primary action and its overflow.

**Steps**

1. Click the **body** of the Spawn button.
2. Cancel, then click the **caret**.

**Expect**

- The body opens the Spawn dialog directly.
- The caret opens a small menu with exactly **Adopt** and **Import
  bundle**.
- On a narrow viewport the split button still fits the header without
  pushing anything off-screen — keeping the header uncrowded on mobile
  is why the two secondary actions live behind the caret.

**📷 Screenshot**: `dash-07-caret-menu.png` — the open overflow menu.

**Cleanup**: Escape.

---

### DASH-08 — Themes

**Covers**: the three themes and their persistence.

**Steps**

1. Settings → Appearance. Switch to **Tycho**, then **Light**, then
   back to **Orchestron**.
2. Reload after each switch.
3. With Light active, open the Graph page.

**Expect**

- Each theme applies immediately, via `data-theme` on `<html>`.
- The choice survives a reload (`localStorage`).
- No unstyled flash and no element left with a hardcoded colour that
  fights the theme — check the status pills, chips and the filter bar
  in each.
- Graph chrome (Controls, MiniMap, background dots) follows the theme:
  dark on Orchestron and Tycho, light on Light.

**📷 Screenshot**: `dash-08-themes.png` — the same dashboard in all
three.

**Cleanup**: restore your preferred theme.

---

### DASH-09 — PWA on a phone `[full sweep]`

**Covers**: pairing, install, and the transcript view over polling.

**Steps**

1. On the host, open `/pair` in an authenticated browser.
2. Scan the QR with the phone.
3. Install to the home screen (iOS: Share → Add to Home Screen;
   Android Chrome: install prompt).
4. From the installed app: open a session, read its transcript, send a
   turn, and download a bundle
   ([`export-import.md`](export-import.md) `BUNDLE-01`).

**Expect**

- The token lands in the phone's `localStorage` and survives tabs and
  reloads.
- The installed PWA opens without browser chrome.
- The transcript updates as the turn runs (REST polling — this is
  deliberately not SSE).
- Sending works.
- The bundle download works, which is what the auth-aware fetch is
  for — a plain link would 401 here.

**📷 Screenshot**: `dash-09-pwa.png` — the installed app on the phone.

**Cleanup**: none.

---

### DASH-10 — Recovering a wedged device

**Covers**: `/api/reset`, the escape hatch that has to work when the
web bundle does not.

**Steps**

1. On the phone (or a spare browser profile), visit `/api/reset`.
2. Wait.

**Expect**

- The page unregisters the service worker and clears caches, storage
  and IndexedDB.
- It redirects to `/pair` after ~3 s.
- Re-pairing from the QR restores access.
- It is served by the **API**, not Next — so it still works when the
  web bundle is broken. Worth confirming once by stopping the web
  process and loading it anyway.

**Cleanup**: re-pair the device.

---

## Notes on current shipped behaviour

- **Transcripts poll; they do not stream.** An SSE implementation was
  tried and removed — it failed in too many PWA states. A scenario
  asserting an EventSource connection is asserting a reverted design.
- **Deleting a project does not delete its sessions.** Their cards
  survive showing the raw project uuid, their tmux processes keep
  running, and files on disk are untouched. New spawns against the
  deleted id fail. The project delete dialog spells all of this out,
  and shows an amber warning when the project still has active
  sessions.
- **The context indicator is Claude-only** — `ctx N / limit [bar] ⤴N`
  in the transcript header, with the `⤴` chip appearing once Claude has
  auto-compacted at least once. Codex reports its own context window
  per turn; other harnesses show nothing, which is correct rather than
  missing.
