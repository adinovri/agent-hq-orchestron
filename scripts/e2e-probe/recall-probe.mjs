#!/usr/bin/env node
/**
 * recall-probe.mjs — the two-turn recall assertion, end to end, as the
 * reference shape for anything a sweep writes under `scratchpad/`.
 *
 *     node scripts/e2e-probe/recall-probe.mjs ./env.json
 *
 * It exists because both NF39 and NF40 were defects in throwaway probes that
 * `.gitignore` swallows: the fix landed in a `scratchpad/` file, the next
 * sweep re-derived the probe from scratch, and the same trap was available
 * again. The helpers next to this file are the durable half; this is the
 * worked example that shows how to hold them.
 *
 * env fixture keys used: `api`, `token`, `projectHeadless`.
 */
import { loadEnvFile, describeEnvFile } from './env-file.mjs'
import { assertRecall, maxSeq } from './recall.mjs'

// NF40: the fixture is an argument, it is honoured, and the run SAYS which
// document it measured. An unread extra argument throws here rather than
// quietly measuring a stale session.
const { file, env } = loadEnvFile(process.argv, { positionals: 0 })
console.log(describeEnvFile(file))

const API = env.api ?? process.env.E2E_API ?? 'http://127.0.0.1:8091'
const H = { Authorization: `Bearer ${env.token}`, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function api(p, init) {
  const r = await fetch(API + p, { headers: H, ...init })
  const t = await r.text()
  try { return { __status: r.status, ...JSON.parse(t) } } catch { return { __status: r.status, raw: t } }
}
// 500 ms floor between polls, honour a 429's delay — docs/e2e-tests/00-setup.md §7
async function settle(id, timeoutMs = 180_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const r = await api(`/api/sessions/${id}`)
    if (r.__status === 429) { await sleep(4200); continue }
    if (/^(idle|needs_input|failed)$/.test(r.status)) return r
    await sleep(700)
  }
  return null
}
const entries = async (id) => (await api(`/api/sessions/${id}/transcript`)).entries ?? []

const WORD = 'apricot'
const s = await api('/api/sessions', {
  method: 'POST',
  body: JSON.stringify({
    projectId: env.projectHeadless,
    prompt: `Reply with the single word: ${WORD}. Do nothing else.`,
    model: 'claude-haiku-4-5',
    useTmux: false,
  }),
})
if (s.__status !== 200 && s.__status !== 201) { console.error('FAIL spawn', s.__status, s); process.exit(1) }
await settle(s.id)

// GUARD 2, and it has to happen HERE — before the send. Reading the baseline
// afterwards is the vacuous pass: turn 1's own answer satisfies the regex.
const baselineSeq = maxSeq(await entries(s.id))

// b18 trap: the route is /input, NOT /send. A wrong path 404s silently and
// every turn-2 assertion then passes against turn-1 data.
const send = await api(`/api/sessions/${s.id}/input`, {
  method: 'POST',
  body: JSON.stringify({ prompt: 'In my very first message I asked you to reply with one specific word. What was that word? Answer with that word only.' }),
})
if (send.__status !== 200) { console.error('FAIL turn 2 rejected', send.__status); process.exit(1) }
const rec2 = await settle(s.id)

// GUARD 1 lives inside assertRecall: the resume pair Claude Code injects is
// skipped, so the answer cannot be "No response requested."
let r
for (let i = 0; i < 90; i++) {
  r = assertRecall(await entries(s.id), {
    baselineSeq,
    expect: new RegExp(WORD, 'i'),
    // Passed only so the evidence line shows what was NOT scored. NF39:
    // finalResponse is the structured-output SUMMARY, never the model's prose.
    finalResponse: rec2?.finalResponse,
  })
  if (r.answered) break
  await sleep(1000)
}

console.log(r.ok ? 'PASS' : 'FAIL', 'turn-2 answer recalls turn 1 (transcript, not the summary)', r.detail)
process.exit(r.ok ? 0 : 1)
