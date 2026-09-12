# scripts/e2e-probe/

The parts of a sweep probe that are worth keeping.

A sweep writes its probes into `scratchpad/e2e-runs/<date>-<batch>/probes/`,
which `.gitignore` swallows. That is right for a probe — it is pointed at one
run's fixtures and one run's session ids. It is wrong for the *rules* a probe
has to follow, and post-batch-20 filed two findings that were both exactly
that: a rule, learned the hard way, that lived only in a throwaway file and so
was available to be got wrong again on the next sweep.

| File | What it holds |
|---|---|
| [`recall.mjs`](recall.mjs) | Which transcript entry counts as "the answer" to a turn — NF39's two guards. Pure. |
| [`env-file.mjs`](env-file.mjs) | Which fixture document a probe is measuring — NF40. |
| [`recall-probe.mjs`](recall-probe.mjs) | A runnable two-turn recall probe; the shape to copy from. |
| `*.test.mjs` | `node --test`, no network. Run by `npm test` via `npm run test:probe`. |

These are plain `.mjs` on purpose: `scratchpad/` probes are ESM run straight
off disk by `node`, with no build step and no TypeScript, so anything they can
import has to be too.

---

## recall.mjs — assert on the transcript, never on `finalResponse`

`finalResponse` is **not the model's words**. With structured output on — the
default — `session-manager.ts` assigns `patched.finalResponse = doc.summary`,
and `docs/e2e-tests/headless-flow.md` (HEADLESS-06) documents prose landing
there only when `headlessStructuredOutput` is off. Post-batch-20 both recall
assertions scored against it and both reported FAIL while the product was
behaving correctly:

| scenario | `finalResponse` (a summary) | the actual answer |
|---|---|---|
| HEADLESS-01 | `"Responded with the requested word."` | `seq 8` → `ready` |
| LIFE-06 | `"Responded to user request as instructed."` | `seq 8` → `apricot` |

The post-batch-19 PASS on the same assertion was luck. Read
`GET /api/sessions/:id/transcript` instead, and let `findRecallAnswer` pick the
entry, because two things will otherwise pick the wrong one:

1. **The resume pair.** Between headless turns Claude Code injects
   `Continue from where you left off.` / `No response requested.` (seq 5/6 in
   a two-turn session). "The last assistant entry" settles on the nudge reply
   and scores it as the answer.
2. **A missing baseline.** Poll before the turn-2 *user* entry is persisted and
   turn 1's answer looks like the answer — so the assertion passes
   **vacuously** on the word turn 1 planted. Observed as a PASS reading
   `answerSeq=1 afterUserSeq=0 text="apricot"`.

```js
import { assertRecall, maxSeq } from '../../scripts/e2e-probe/recall.mjs'

const baselineSeq = maxSeq(await entries(id))   // BEFORE the send. Not after.
await send(id, 'What was that word?')
const r = assertRecall(await entries(id), {
  baselineSeq,
  expect: /apricot/i,
  finalResponse: rec.finalResponse,   // printed, deliberately not scored
})
```

`baselineSeq` has no default and throws when it is missing — the shape it
guards against is a silent pass, so it cannot be optional.

## env-file.mjs — honour the fixture argument, or reject it

Matrix probes take the fixture positionally, after their own arguments:

```bash
node nf26.mjs KillConfirmDialog ./env-kill.json   # 1 positional
node headless-life.mjs ./env.json                 # 0 positionals
```

`nf30.mjs` accepted that argument and read `./env.json` regardless. The
standing remedy for the known Kill flake — re-mint into `env-kill.json`,
re-run — therefore measured the *stale* session, failed identically to the
flake it was meant to rule out, and cost three 30 s timeout runs and nearly a
false regression filed against NF30.

```js
const { file, env } = loadEnvFile(process.argv, { positionals: 1 })
console.log(describeEnvFile(file))   // say which document this run measured
```

`resolveEnvFile` throws on a missing fixture and throws on an argument the
probe does not read. Both are deliberate: a probe that accepts an argument it
ignores is worse than one that rejects it, because rejecting it fails in a
second.
