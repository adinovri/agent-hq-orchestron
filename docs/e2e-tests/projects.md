# Projects — E2E Test Plan

`/projects` — the registry: register a project, edit its defaults,
delete it, and find it again among a list. A project is the unit a
session is spawned against, and its defaults are what the spawn dialog
and the pencil dialog inherit from.

What is **not** here: how those defaults are resolved at spawn time
(that is [`spawn-session.md`](spawn-session.md) and
[`metadata-edit.md`](metadata-edit.md)), and the MCP auto-inject config
(that is [`mcp-spawn.md`](mcp-spawn.md) — and it is not a project
field; see the note at the end).

Spec: [USAGE.md § Projects](../USAGE.md#projects)

---

## Preconditions

- Everything in [`00-setup.md`](00-setup.md).
- **Workspace paths on disk.** Registration rejects a path that does
  not exist, so create scratch directories before the form needs them:

  ```bash
  mkdir -p /tmp/orchestron-e2e/ws-scratch /tmp/orchestron-e2e/ws-scratch2
  ```

- **`enableHeadlessMode: true`** (the default) for `PROJ-02` — the
  *Use tmux by default* checkbox is hidden when the global switch is
  off. [`feature-flag.md`](feature-flag.md) `FLAG-02` covers the
  hidden case; do not duplicate it here.

> `./scripts/e2e-env.sh fixtures` registers the five fixture projects
> over the API and is the fast path for every other file. **This file
> uses the form**, because registration *is* what it tests.

---

## Scenarios

### PROJ-01 — Register a project through the form `[smoke]`

**Covers**: create — the form, its required fields, the 201, and the
card that appears. Nothing in the plan can spawn anything without this
working.

**Steps**

1. Open `$ORCH_WEB/projects` and click **Register**.
2. Read the dialog title, then submit with **Name empty** and see what
   happens.
3. Fill in: Name `e2e-scratch`, Path `/tmp/orchestron-e2e/ws-scratch`,
   Agent Type `claude`. Leave both defaults on *Harness default*.
4. Click **Register**.
5. Find the new card.
6. Confirm over the API:

   ```bash
   . ~/.orchestron-e2e/e2e.env
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects" \
     | python3 -c '
   import json,sys
   for p in json.load(sys.stdin)["projects"]:
       if p["name"].startswith("e2e-scratch"):
           print(json.dumps(p, indent=2))'
   ```

7. Now try to register a project whose **path does not exist**
   (`/tmp/orchestron-e2e/nope`).

**Expect**

- Dialog title reads **Register Project** (the same component titles
  itself **Edit Project** in `PROJ-02`).
- **Name**, **Path** and **Agent Type** carry a red `*`. Agent Type
  defaults to `claude` and offers `codex` and `opencode`.
- Both default selects offer `— Harness default` as their first option;
  choosing it stores **no field at all** rather than an empty string —
  confirm in step 6 that `defaultModel` and `defaultEffort` are
  **absent** from the JSON, not `""`.
- On success the dialog closes, the list refreshes without a manual
  reload, and a card shows the name, the path in mono, and
  `Created just now`.
- The header count increments: `<n> registered`.
- The API record carries a uuid `id`, the `name`, `path`, `agentType`
  and a `createdAt`.
- Step 7 is rejected with **422** and a message about the path. The
  dialog stays open and shows the error inline rather than closing.
- An empty Name in step 2 is rejected by the API with **400** (the
  dialog does not gate it client-side) and the error renders in red at
  the bottom of the form.

**📷 Screenshot**: `proj-01-card.png` — the new card and the updated
count.

**Cleanup**: keep `e2e-scratch`; `PROJ-02` and `PROJ-03` use it.

---

### PROJ-02 — Edit defaults: model, effort, *Use tmux*

**Covers**: update — the three fields a session inherits, and the
round-trip through `PATCH /api/projects/:id`. A project whose defaults
silently fail to save produces sessions on the wrong model, which shows
up as a cost surprise rather than as an error.

**Steps**

1. Hover the `e2e-scratch` card and click the **pencil**.
2. Confirm the form is pre-filled from the record.
3. Set **Default Model** to a Haiku option and **Default Effort** to
   `medium`.
4. **Untick** *Use tmux by default* and read the helper text under it.
5. Save, then reopen the dialog.
6. Confirm over the API:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects/<id>" | python3 -m json.tool
   ```

7. Set both defaults back to `— Harness default` and save again.
8. Open the **Spawn** dialog against `e2e-scratch` and read what it
   inherits.

**Expect**

- Title reads **Edit Project**; the button reads **Save Changes**, not
  **Register**.
- Every field is pre-filled — name, path, agent type, both defaults,
  group, tags. A blank pre-fill is a regression: it would silently blank
  the record on save.
- The card grows two chips: the model string, and `effort:MEDIUM`
  (uppercased in the chip, lower-case in the record).
- The *Use tmux by default* helper text **changes with the checkbox** —
  ticked, it says new sessions run interactively in tmux; unticked, it
  names the per-turn process (`claude -p`, or `codex exec` when Agent
  Type is `codex`). Assert that the text tracks both the checkbox
  **and** the selected harness.
- The API record holds `defaultModel`, `defaultEffort: "medium"` and
  `defaultUseTmux: false`.
- Step 7 **removes** the fields rather than writing empty strings —
  re-read and confirm they are absent, and the chips are gone from the
  card.
- Step 8: the spawn dialog shows the project's values as the inherited
  defaults, tagged as coming from the project. The mechanics of that
  tag belong to [`metadata-edit.md`](metadata-edit.md); here just
  confirm the value arrives.

**📷 Screenshot**: `proj-02-chips.png` — the card with both chips.

**Cleanup**: leave `e2e-scratch` with no defaults set.

---

### PROJ-03 — Delete a project that has sessions

**Covers**: delete, and the five consequences the dialog promises. The
interesting part is what **survives**: deleting a project does not
delete its sessions and does not kill its processes.

**Steps**

1. Spawn a session against `e2e-scratch` and let it finish one turn.
2. Return to `/projects`, hover the card, click the **trash** icon.
3. Read the dialog: the *What happens* list, and the amber count
   banner.
4. Click **Delete**.
5. Check the dashboard, the session's detail page, and the API:

   ```bash
   curl -s -o /dev/null -w 'project → %{http_code}\n' \
     -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects/<id>"
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/sessions" \
     | python3 -c '
   import json,sys
   for s in json.load(sys.stdin)["sessions"]:
       print(s["id"][:8], s["projectId"][:8], s["status"])'
   ```

6. Try to spawn a new session against the deleted project id over the
   API.
7. Confirm the workspace directory still exists on disk.

**Expect**

- Dialog title **Delete project?**, the project name in bold, and the
  five-item *What happens* list: record removed; **session records
  stay** but show only the uuid; **running tmux and agent processes are
  not killed**; new spawns against the id **fail**; files on disk
  **untouched**.
- The amber banner appears only when the project has sessions, and
  names the total — plus `— <n> still active` when any are in a live
  status.
- `DELETE` answers **204**; afterwards `GET /api/projects/<id>` is
  **404**.
- The session from step 1 is **still listed** on the dashboard, still
  in its status, and its card/detail now shows the **project uuid**
  where the name used to be.
- Step 6 fails. Record the status code and message you actually get.
- The directory from step 7 is still there — deletion is registry-only.
- The list refreshes without a reload and the header count decrements.

**📷 Screenshot**: `proj-03-confirm.png` — the dialog with the amber
banner visible.

**Cleanup**: delete the orphaned session record, and re-register
`e2e-scratch` if a later scenario needs it.

---

### PROJ-04 — List filtering: search, group, tags

**Covers**: the three filters, their interaction, and the two distinct
empty states. Also that filtering is **client-side** over the full list,
which is why the header count does not move.

**Steps**

1. With the five fixtures plus `e2e-scratch` registered, give two
   projects a **Group** (`backend`) and one a couple of **Tags**
   (`java, nanovest`) via the pencil.
2. Type `haiku` into the search box.
3. Clear it and type a **path** fragment instead (`ws-headless`).
4. Pick `backend` from the group select.
5. Click a tag chip, then click a second one.
6. Type a string that matches nothing.
7. Click **Clear filters**.
8. Compare against the API's server-side filters:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects?group=backend" \
     | python3 -c 'import json,sys;print([p["name"] for p in json.load(sys.stdin)["projects"]])'
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects?tag=java" \
     | python3 -c 'import json,sys;print([p["name"] for p in json.load(sys.stdin)["projects"]])'
   ```

**Expect**

- Search matches **name or path**, case-insensitively — step 3 finds a
  project by its path alone.
- The **group select only appears** when at least one project has a
  group; likewise the **tag chip row**. On a clean host both are absent
  — that is correct, not a missing control.
- Tag chips are **AND**, not OR: selecting two shows only projects
  carrying **both**. Selected chips render filled blue.
- Filters **compose** — search plus group plus tags all narrow together.
- The header still reads the **unfiltered** total (`<n> registered`).
  Filtering hides cards; it does not change the count. Do not write an
  assertion that they agree.
- Two different empty states:
  - **no projects at all** → the dashed-border panel, *No projects
    yet*, and a *Register your first project* button;
  - **projects exist but none match** → *No projects match your
    filters* and a **Clear filters** link.
  These are not interchangeable; a sweep that sees the wrong one has
  found a real bug.
- **Card order is the API's order** — there is no sort control and no
  client-side sort. Note the order the API returns and assert the page
  preserves it; do not assert alphabetical or recency unless the API
  does that.
- The API's `group` and `tag` query params return the same sets the UI
  shows for the same filter, so a divergence localises to one side.

**Cleanup**: clear all filters; remove the group and tags you added.

---

### PROJ-05 — Per-harness config and Advanced options

**Covers**: the environment a project imposes on its sessions — the
config-dir override, extra env vars and extra args. This is the real
per-project config surface, and it is the one place a wrong value
produces a session running as the wrong identity.

**Steps**

1. Edit `e2e-scratch` with Agent Type `claude` and read the field below
   the defaults.
2. Switch Agent Type to `codex` **without saving** and read it again.
3. Switch back to `claude`. Confirm what happened to the value you had
   typed.
4. Set `CLAUDE_CONFIG_DIR` to `~/ClaudeConfigs/e2e`.
5. Expand **Advanced options**.
6. Add an env pair `E2E_MARKER` = `batch6`, then add a second and
   remove the first with its `✕`.
7. Put `--verbose` in **Extra args**.
8. Save, reopen, and confirm over the API:

   ```bash
   curl -s -H "Authorization: Bearer $TOKEN" "$ORCH/api/projects/<id>" | python3 -m json.tool
   ```

9. Spawn a session against the project and confirm the env reached it.

**Expect**

- With `claude` selected: a **`CLAUDE_CONFIG_DIR`** input plus helper
  text saying it overrides the variable for this project's sessions and
  that blank inherits from the API process.
- With `codex` selected: a **`CODEX_HOME`** input instead, with its own
  helper text about pre-registered `auth.json`. **Exactly one** of the
  two is visible at a time — the one matching the selected harness.
- Step 3: the `claude` value is **still there**. The two fields hold
  their values independently, so toggling harness back and forth loses
  neither. That is the assertion worth having — the easy regression is
  a shared state that clobbers one with the other.
- **Advanced options** is collapsed by default, behind a `▶` /`▼`
  disclosure, and holds exactly two things: **Extra env vars** and
  **Extra args**.
- Env pairs render as `KEY=value` rows with a `✕`; **Add** appends and
  clears the two inputs. Removing the first leaves the second intact
  (an index-based remove is easy to get wrong).
- Extra args is a **comma-separated** string.
- All of it round-trips: reopening shows the same values, and the API
  record holds them under `agentConfig`.
- Step 9: the session runs with the overridden config dir. Assert via
  the session's own detail panel or its process environment, whichever
  [`session-details.md`](session-details.md) already covers — do not
  re-derive it here.

> **There is no MCP field on a project.** `ProjectMetadata` has no MCP
> key; auto-inject is per **session** (`mcpConfigPath` for Claude,
> `mcpConfigInline` for Codex), written by session-manager at spawn and
> not editable from this page or any other. A scenario looking for
> "project MCP config" is looking for something that does not exist —
> [`mcp-spawn.md`](mcp-spawn.md) covers the real mechanism.

**Cleanup**: clear the env pair and extra args; delete `e2e-scratch`
and any session it spawned.

---

## Notes for scenario authors

- **`fixtures` is the fast path, the form is the tested path.** Use
  `./scripts/e2e-env.sh fixtures` everywhere else; use the dialog here.
  Note that `fixtures` deletes and recreates anything named `e2e-*` —
  including `e2e-scratch`, so do not run it mid-file.
- **Do not edit the five fixtures.** Each is shaped by what it must
  *not* set (see [`00-setup.md`](00-setup.md) § 4): putting a model on
  `e2e-claude` destroys the "nothing to inherit" case, and putting one
  on `e2e-headless` breaks the `(project)` source-tag assertions in
  [`metadata-edit.md`](metadata-edit.md). Register `e2e-scratch` and
  break that instead.
- **Session counts on the cards come from `/api/sessions`, refetched
  every 15 s** (projects themselves every 10 s). A count that looks
  stale for a few seconds after a spawn is the poll interval, not a
  bug. Reload before reporting a mismatch.
- **`active` on a card means one of five statuses** — `spawning`,
  `waiting`, `running`, `needs_input`, `idle`. Notably `sleeping` is
  **not** active here, while the dashboard's own counters group things
  differently. Compare each against its own definition, never against
  the other.
- **Project ids are validated at the route.** `:id` must match
  `^[0-9a-fA-F-]{8,64}$` or the route returns **400** before the domain
  layer sees it — that guard exists because ids are joined into a file
  path, and a percent-encoded `../` once reached arbitrary records. A
  path-traversal probe returning 400 is the guard working; do not file
  it as a rejected valid id.
- **Cost.** `PROJ-03` and `PROJ-05` each want one cheap turn. Point
  `e2e-scratch` at Haiku for the duration rather than spawning on
  `e2e-claude-opus`.
