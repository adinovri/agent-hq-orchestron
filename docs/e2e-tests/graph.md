# Delegation graph — E2E Test Plan

`/graph` — a React Flow canvas of one session tree: nodes coloured by
status, edges labelled with the spawn prompt that created them, laid out
top-to-bottom by dagre, and click-through to session detail.

The page renders **one root at a time**. There is no all-sessions view:
without a root uuid there is nothing to draw, and the empty state says
so. Scenarios that expect a global graph are testing a feature that does
not exist.

Spec: [USAGE.md § Delegation graph](../USAGE.md#delegation-graph) ·
tree construction in [`mcp-spawn.md`](mcp-spawn.md) `MCP-02`, which this
file assumes rather than repeats.

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **A parent with at least two children**, from
  [`mcp-spawn.md`](mcp-spawn.md) `MCP-02`. Note the parent uuid — it is
  the `root` for every scenario here.
- **Children in different statuses** if you can arrange it, for
  `GRAPH-01`'s colour assertions. One running and one terminal is
  enough.

```bash
. ~/.orchestron-e2e/e2e.env
ROOT=<parent uuid>
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/delegation/$ROOT" \
  | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("nodes", [n["id"][:8] for n in d["nodes"]])
for e in d["edges"]:
    print("edge", e["source"][:8], "->", e["target"][:8], "|", e.get("label"))'
```

---

## Scenarios

### GRAPH-01 — Parent and children render with status colours `[smoke]`

**Covers**: the whole draw path — root param → `/api/delegation/:root`
→ node/edge build → dagre layout → React Flow. Also the palette, which
is shared with the dashboard status pills and drifts silently when one
side changes.

**Steps**

1. Open `$ORCH_WEB/graph?root=<parent uuid>`.
2. Read the toolbar.
3. Count nodes and edges on the canvas.
4. Compare each node's fill against that session's pill on
   `$ORCH_WEB/dashboard`.
5. Hover an edge and read its label.

**Expect**

- Toolbar: the heading **Delegation Graph**, an input **pre-filled with
  the root uuid from the query string**, and the hint `Click a node to
  view session` pushed to the right edge.
- One node per session in the tree — parent plus every descendant, not
  just direct children. Each label is the **first 8 characters** of the
  uuid, then a newline, then the session's status.
- One edge per parent→child relationship, drawn **top-to-bottom**
  (dagre `rankdir: TB`) with the parent above its children.
- Edge labels are the spawn prompt, truncated by the API to **60
  characters**.
- Edges into a `running` or `spawning` child are **animated**; the rest
  are static.
- **The root node is visually distinct** — a white 2px border and a
  white glow ring — while every other node takes a 1px border in its own
  status hue.
- Node fills match the dashboard pill for the same status. The nine
  states of state-machine v2 each have a distinct colour; `idle` and
  `killed` are the two closest (zinc-500 vs zinc-600) and are the pair
  most worth checking by eye.
- A node for a session the sessions list does not contain still renders,
  labelled with the uuid stub and **no status line**. Do not treat that
  as a failure — it is the deliberate fallback.

**📷 Screenshot**: `graph-01-tree.png` — root, both children, both
edges with labels, in one frame.

**Cleanup**: none.

---

### GRAPH-02 — Click-through to session detail

**Covers**: the one interaction on the page, and the interaction that
stops working the moment node types are customised.

**Steps**

1. From the graph, click a **child** node — on the node body, not its
   edge or its label.
2. Read the URL and the page you land on.
3. Go back and click the **root** node.
4. Go back again, then pan and zoom the canvas and click a node.

**Expect**

- Each click navigates to `/session/<the full uuid of that node>` —
  the full uuid, not the 8-char stub the label shows.
- The session detail page that loads is the one the node named: check
  its header uuid against the node label's stub.
- Clicking the root behaves the same as clicking a child; the root's
  ring is decoration, not a different affordance.
- Navigation works after panning and zooming. Nodes carry
  `cursor: pointer`, so the hit area is the whole node box.
- Clicking **empty canvas**, an **edge**, or the **MiniMap** navigates
  nowhere.

**Cleanup**: return to `/graph?root=<parent uuid>`.

---

### GRAPH-03 — No root, unknown root, malformed root

**Covers**: three different nothings, which the page renders in two
different ways. Worth separating, because the useful message appears in
only one of them.

**Steps**

1. Open `$ORCH_WEB/graph` with **no** query string.
2. Read the canvas area and the toolbar input.
3. Type a well-formed uuid that is not a session into the input.
4. Confirm what the API says:

   ```bash
   curl -s -o /dev/null -w 'unknown root → %{http_code}\n' \
     -H "Authorization: Bearer $TOKEN" \
     "$ORCH/api/delegation/00000000-0000-0000-0000-000000000000"
   ```

5. Open `$ORCH_WEB/graph?root=not-a-uuid`.
6. Finally, type the uuid of a **real session with no children** into
   the input.

**Expect**

- With no root: the canvas shows
  `No delegation graph — select a session root via ?root=<uuid>`,
  centred, and the input is **empty**. No React Flow chrome — no
  controls, no minimap, no dot grid — because the whole component
  early-returns before rendering the canvas.
- With an unknown root: the API answers **404**, `delegation` stays
  undefined, and the page falls back to the **same** empty-state text.
  So a typo and no input at all look identical; the 404 is only visible
  in the network tab. Record that as the known shape, not as a bug.
- With a malformed root: same empty state; no crash, no error overlay.
- With a real but **childless** session as root: **one** node renders —
  the root, with its white ring — and **no** edges. The root is added to
  the node set explicitly, so it draws even when the edge list is empty.
  This is the case that distinguishes "nothing to draw" from "a tree of
  one".
- `Loading…` appears in the toolbar while the delegation query is in
  flight, and clears afterwards.

> **The input is one-way from the URL.** `?root=` populates it and
> thereafter the field's value is pinned to the resolved root, so typing
> over a URL-supplied root does not change the graph. Reaching a
> different root means editing the URL. Assert that behaviour; do not
> assert that typing works when the page was opened with `?root=`.

**📷 Screenshot**: `graph-03-empty.png` — the empty state with the
instruction text.

**Cleanup**: none.

---

### GRAPH-04 — Narrow viewport

**Covers**: what the graph does on a phone. The answer is "the same
canvas, smaller" — **there is no list or tree fallback**. This scenario
pins that, because "add a mobile fallback" is a reasonable-sounding
change that would silently invalidate `GRAPH-01` and `GRAPH-02`.

**Steps**

1. Set the viewport to **390 × 844** (phone).
2. Open `$ORCH_WEB/graph?root=<parent uuid>`.
3. Read the toolbar, then the canvas.
4. Pinch-zoom out, then pan, then tap a node.
5. Widen back to desktop and confirm the canvas re-fits.

**Expect**

- **The same React Flow canvas renders.** No list view, no accordion,
  no "open on desktop" message. If any of those appear, the app has
  gained a fallback and this scenario is the spec that needs updating
  first.
- `fitView` with `padding: 0.2` means the whole tree is in frame on
  load at phone width, scaled down — not clipped, and not requiring a
  pan to find the root.
- Zoom is clamped to **0.2 – 2.0**. Past the far end, pinching does
  nothing further; that is the clamp, not a stuck gesture.
- The toolbar keeps all four items on one row. The input is
  `max-w-xs`, so it shrinks rather than pushing the hint off-screen;
  the `Click a node to view session` hint may be tight but must not
  overflow the viewport horizontally.
- Tapping a node navigates, exactly as `GRAPH-02`.
- Controls and MiniMap both still render at phone width. They overlap
  the canvas rather than reflowing — acceptable, but note it if they
  cover the root node at the default fit.

**📷 Screenshot**: `graph-04-mobile.png` — 390px wide, whole tree in
frame.

**Cleanup**: restore the desktop viewport.

---

### GRAPH-05 — Theme follows the app, live

**Covers**: React Flow's own chrome, which has its own palette and does
not inherit CSS variables. It is wired to the app theme by a
`MutationObserver` on `<html data-theme>` — a mechanism no other page
uses, and the reason a theme switch here is worth its own scenario.

**Steps**

1. Open the graph with a root and the **Orchestron** (default dark)
   theme active.
2. In a second tab open `$ORCH_WEB/settings` and switch the theme to
   **Light**; return to the graph tab **without reloading**.
3. Switch to **Tycho** and return again.
4. Reload the graph page and confirm the theme survived.

**Expect**

- The dot-grid background, Controls and MiniMap all re-style **without
  a reload** when the theme changes. That is the observer doing its job;
  a reload-only change means it regressed.
- Light theme: dark dots on a light ground, and a light mask over the
  MiniMap. Dark themes: light dots on a dark ground, dark mask.
- Controls and MiniMap take `var(--card)` / `var(--border)` /
  `var(--card-foreground)`, so they read as app chrome in all three
  themes — never a white box on a dark ground.
- **Node fills do not change with the theme.** The status palette is
  saturated on purpose so it reads on all three grounds. A theme-varying
  node colour is a regression.
- After reload the theme persists, from `localStorage` key
  **`orchestron_theme`** (values `orchestron` / `tycho` / `light`).
  Setting the emulated OS colour scheme does **not** change the app
  theme — see [`settings.md`](settings.md) `SET-01`.

**📷 Screenshot**: `graph-05-themes.png` — the same tree in light and
in dark.

**Cleanup**: restore the **Orchestron** theme.

---

## Notes for scenario authors

- **The graph is per-root, and the root comes from the URL.** Every
  scenario needs a uuid in hand before it starts. Get it from
  `MCP-02`'s parent, not by hunting the dashboard.
- **`/api/delegation/:root` returns nodes and the page ignores them.**
  The response carries both `nodes` (full session records) and `edges`;
  the component builds its node set from the **edge endpoints plus the
  root**, and gets status from the separate `/api/sessions` query, which
  refetches every 5 s. Consequence worth knowing when an assertion
  looks flaky: **node colours can lag an edge change by up to 5 s.**
- **Do not assert node pixel positions.** Dagre is deterministic for a
  given graph but a node added anywhere re-flows the whole layout.
  Assert relative order — parent above child, siblings on one rank —
  never coordinates.
- **Cost.** Nothing here spawns anything if `MCP-02` has already run.
  This is one of the cheapest files in the plan; keep it that way by
  reusing the existing tree rather than building a fresh one.
