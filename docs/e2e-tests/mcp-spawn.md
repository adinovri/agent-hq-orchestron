# MCP `spawn_session` & Delegation — E2E Test Plan

Every spawn auto-loads an MCP server giving the running agent ten
tools. No `.mcp.json` setup: the session manager writes a per-session
config at `~/.orchestron/mcp-configs/<sid>.json` with
`ORCHESTRON_SESSION_ID` pre-baked and passes `--mcp-config` to the
harness.

This file tests it from the *user's* side — what the dashboard shows
when an agent fans out — plus the guardrails and the mode-inheritance
rule, which is the one piece of behaviour a reader is most likely to
guess wrong.

Spec: [USAGE.md § Orchestron MCP server](../USAGE.md#53-orchestron-mcp-server-option-2--with-guardrails) ·
[USAGE.md § Passive terminal report](../USAGE.md#51-passive-terminal-report-option-1-in-the-design)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- `enableHeadlessMode` **on**.
- Fixture projects `e2e-claude` (no mode preference → tmux) and
  `e2e-headless` (project default: headless). Both are needed —
  the inheritance rule turns on whether parent and child share a
  project.
- Headroom under `maxConcurrent` for a parent plus a few children.
- These scenarios drive a real agent, so they cost real quota. Keep
  child prompts to the *Fast prompt*.

**Prompt shape for a parent.** Ask for the tool call explicitly rather
than hoping for it:

> Use the `spawn_session` MCP tool to start one child session in
> project `<name>` with the prompt `Reply with the single word: ready.`
> Report the child's session id and its effective `useTmux`, then stop.

---

## Scenarios

### MCP-01 — A parent spawns a child

**Covers**: the tool being present and wired without any manual config.

**Steps**

1. Spawn a tmux session in `e2e-claude` with the parent prompt above,
   targeting `e2e-claude`.
2. Watch the transcript, then the dashboard.

**Expect**

- The agent finds `spawn_session` — no "tool not available" and no
  permission modal freezing the turn. Orchestron passes
  `--allowedTools mcp__orchestron__…` so the ten first-party tools are
  pre-approved even under a managed policy that disables
  `bypassPermissions`.
- A **child session appears on the dashboard** in the target project
  and runs its own prompt.
- The tool result the agent reports back includes `sessionId`,
  `status`, and the **effective `useTmux`**.
- `~/.orchestron/mcp-configs/<parent sid>.json` exists.

**📷 Screenshot**: `mcp-01-parent-and-child.png` — the dashboard with
both cards visible.

**Cleanup**: Kill and Delete record on both, child first.

---

### MCP-02 — Delegation chips on both cards `[full sweep]`

**Covers**: the tree being visible at list and detail level without
opening Graph.

**Steps**

1. From `MCP-01`'s parent, spawn a **second** child.
2. Read the parent's dashboard card and its detail header.
3. Read a child's card and detail header.
4. Hover each chip.
5. Open menu → **Graph**.

**Expect**

- Parent gets **`⑃ 2`** — the count of direct children. Hover gives
  detail and points at Graph for the tree view.
- Each child gets **`⑃ parent: <8-char>`**, linking to the parent's
  detail page. The 8-char slice matches the parent's id chip elsewhere
  in the list, so cross-referencing by eye works. Hover shows a preview
  of the parent's initial prompt.
- The same chips appear on the dashboard cards and in the session
  detail headers.
- A session with neither parent nor children shows no chip at all.
- Graph renders the tree, node fill per status matching the
  StatusPill palette, and its chrome follows the active theme (dark on
  Orchestron/Tycho, light on Light).

**📷 Screenshot**: `mcp-02-chips.png` — parent and child cards
together; `mcp-02-graph.png` — the Graph page.

**Cleanup**: Kill and Delete record on all three.

---

### MCP-03 — Mode inheritance: same project vs cross project

**Covers**: the rule that is easy to state wrong. Omitted, the child
inherits the **parent's** mode — but only when it stays in the
parent's project. A child spawned into a *different* project gets that
project's `defaultUseTmux` instead.

**Steps**

1. Spawn a **headless** parent in `e2e-headless`.
2. Ask it to spawn a child **in its own project**, with no `useTmux`
   argument. Read the child's mode.
3. Ask it to spawn a child **in `e2e-claude`** (a different project,
   default tmux), again with no `useTmux`. Read that child's mode.
4. Ask it to spawn a child in `e2e-claude` **with `useTmux: false`
   explicitly**. Read that child's mode.

**Expect**

2. Child is **headless** — inherited from the parent, same project.
3. Child is **tmux** — `e2e-claude`'s default won. A tool call that
   never mentioned run mode does not override an operator's per-project
   setting.
4. Child is **headless** — an explicit argument beats both.

- In every case the tool result reports the effective `useTmux`, so the
  parent is told rather than left to infer.

**📷 Screenshot**: `mcp-03-mixed-modes.png` — the dashboard showing the
three children with their differing Headless badges.

**Cleanup**: Kill/Archive and Delete record on all four sessions.

> **Known deviation.** The design brief asked for unconditional
> inheritance of the parent's mode; the shipped behaviour scopes it to
> same-project, for the reason above. This scenario asserts the
> **shipped** behaviour. If the decision is ever reversed, step 3's
> expectation flips and this note comes out.

---

### MCP-04 — `wait_for_idle` is withheld from a headless agent

**Covers**: the one tool that is not offered in headless mode. It
blocks until a child goes idle, which can be minutes; a one-shot
invocation has no turn boundary to release it and no way to interrupt,
so the run would simply hang.

**Steps**

1. Spawn a **headless** parent and ask it to list its available
   orchestron MCP tools.
2. Spawn a **tmux** parent and ask the same.

**Expect**

- The headless agent reports **nine** orchestron tools, without
  `wait_for_idle`.
- The tmux agent reports all **ten**.
- Asking the headless agent to use `wait_for_idle` anyway does not hang
  the session — it reports the tool as unavailable and the turn ends.

**Cleanup**: Archive/Kill and Delete record on both.

---

### MCP-05 — Terminal report reaches the parent on archive

**Covers**: the passive coordination primitive — one-way,
best-effort, fired on archive.

**Steps**

1. Spawn a tmux parent, have it spawn one child.
2. Let the child finish, then **Archive** the child.
3. Read the parent's transcript.
4. Repeat with the parent already killed before archiving the child.

**Expect**

- After step 2 a message is queued into the parent's input and appears
  in its transcript, shaped as:

```
[Child session abcd1234 archived — status: succeeded]
Original prompt: <first 200 chars>
Final response: <last assistant text, first 800 chars>
```

- In step 4 **nothing is queued** — the report is skipped when the
  parent is itself in a terminal state.

**📷 Screenshot**: `mcp-05-terminal-report.png` — the report as it
appears in the parent's transcript.

**Cleanup**: Kill and Delete record on both.

---

### MCP-06 — Spawn guardrails

**Covers**: max 10 children per parent, max depth 5, and 5 spawns per
minute per parent. Enforced at `SessionManager.spawn` whenever
`parentSessionId` is set, so REST and MCP callers get the same
protection.

**Steps**

1. **Rate limit** — ask one parent to spawn six children in quick
   succession, each with the *Fast prompt*.
2. **Child cap** — ask a parent to spawn eleven children, pacing them
   under the rate limit.
3. **Depth** — chain: parent asks its child to spawn a grandchild, and
   so on to six levels.

**Expect**

1. The sixth spawn within the minute **fails with an error the agent
   surfaces**, not silently. Waiting out the minute lets it through.
2. The eleventh child fails. The first ten exist.
3. The sixth level fails; the chain stops at five. Depth is computed by
   walking `parentSessionId` pointers back through storage.
- Parallel `spawn_session` calls from one parent cannot race past a cap
  — spawns are serialised per parent by an in-process mutex.

> This scenario creates a lot of sessions and burns quota. Run it
> deliberately, on a quiet host, and clean up thoroughly.

**Cleanup**: Kill and Delete record on every session created. Check
`tmux ls` for strays.

---

### MCP-07 — Shared notes round trip

**Covers**: the key-value coordination primitive, from both the API
and an agent.

**Steps**

```bash
curl -s -X PUT "$ORCH/api/notes/e2e:build.status" \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"value": {"stage": "compile"}, "tags": ["e2e"]}'

curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/notes/e2e:build.status"
curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/notes?prefix=e2e:"
```

Then ask a running agent to read `e2e:build.status` with `note_get` and
to overwrite it with `note_set`.

**Expect**

- The note round-trips through the API with its value and tags.
- The prefix listing returns it and not unrelated notes.
- The agent reads the same value the API wrote.
- After the agent's `note_set`, the record's `updatedBy` is
  **auto-filled with that agent's session id** — the caller does not
  set it.
- The file lands at `~/.orchestron/notes/e2e:build.status.json` with
  `0600` perms.

**Cleanup**:
`curl -X DELETE -H "Authorization: Bearer $TOKEN" "$ORCH/api/notes/e2e:build.status"`

---

### MCP-08 — A pending permission modal still surfaces

**Covers**: the belt-and-braces path. The auto-allowlist covers the ten
first-party tools; anything outside it can still raise a TUI modal, and
that modal must reach the dashboard rather than stalling the session on
`running` forever.

**Steps**

1. Spawn a **tmux** session with a prompt that will trigger a
   permission gate outside the orchestron allowlist — e.g. asking it to
   run a shell command that the host's policy gates.
2. Wait up to ~20 s for the background sweep.
3. Answer the modal from the dashboard.

**Expect**

- Status moves `running` → **`needs_input`** on its own, without
  anyone attaching to the pane.
- The session detail page renders a **PendingPromptBanner** above the
  transcript, with each modal option as a clickable button.
- Clicking an option answers the modal in the pane and the turn
  proceeds; the banner clears optimistically and the next sweep
  confirms.
- The dashboard's *needs input* stat counts the session while it waits.

**📷 Screenshot**: `mcp-08-pending-banner.png` — the banner with its
options.

**Cleanup**: Kill, Delete record.

---

## Notes on current shipped behaviour

- **Trust boundary: orchestron is single-tenant.** Tools taking an
  arbitrary `sessionId` (`read_transcript`, `get_status`, `send_input`,
  `list_sessions`) resolve globally, not scoped to the caller's
  delegation subtree or project. Any spawned agent can read or inject
  into any live session on the host, across projects. This is
  intentional for the local-only trust model and is **not** a finding
  to raise from these scenarios — do not write a scenario asserting
  cross-project isolation, because there is none.
- **Prompt-injection exposure is accepted.** Arguments to
  `spawn_session`, `send_input` and `note_set` are model-decided, so
  content the agent reads can steer them. The guardrails cap blast
  radius; they do not prevent a single malicious note write.
- **The MCP config is per session** and is one of the two files removed
  by Delete record — see [`session-lifecycle.md`](session-lifecycle.md)
  `LIFE-09`.
