/**
 * NF41's defects are argument-shape bugs that appear before any browser or
 * network call, so they are fully testable offline.  These tests are the same
 * family as `env-file.test.mjs`: real process.argv arrays, no mocks, checking
 * the caller-visible sentence rather than the exception class.
 *
 * resolveSessionArg  — 15 cases
 * resolveViewportWidth — 12 cases
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSessionArg, resolveViewportWidth } from './session-arg.mjs'

const GOOD_UUID = '1d1b9ece-6a08-4d72-a10b-2fc53ab820dd'
const BAD_UUID_SHORT = '1d1b9ece-6a08-4d72-a10b'
const FILE_PATH = './env.json'

const argv = (...args) => ['/usr/bin/node', '/probes/detail01.mjs', ...args]

/** Capture the thrown error so we can assert on its message. */
function throws(fn) {
  try {
    fn()
    assert.fail('expected an error to be thrown')
  } catch (err) {
    if (err?.name === 'AssertionError') throw err
    return err
  }
}

// ── resolveSessionArg ──────────────────────────────────────────────────────

test('resolveSessionArg: accepts a well-formed uuid at slot 2', () => {
  assert.equal(resolveSessionArg(argv(GOOD_UUID)), GOOD_UUID)
})

test('resolveSessionArg: accepts a well-formed uuid at a custom slot', () => {
  assert.equal(
    resolveSessionArg(['/n', '/s', 'KillConfirmDialog', GOOD_UUID], { slot: 3 }),
    GOOD_UUID,
  )
})

test('resolveSessionArg: uuid match is case-insensitive', () => {
  const upper = GOOD_UUID.toUpperCase()
  assert.equal(resolveSessionArg(argv(upper)), upper)
})

test('resolveSessionArg: rejects a file path — the NF41 bug', () => {
  // This is the exact invocation that caused the wrong verdict in batch-21.
  // detail01.mjs accepted "./env.json", navigated to /session/./env.json,
  // and returned groups:[] — matching the known DETAIL-01 locator bug.
  const err = throws(() => resolveSessionArg(argv(FILE_PATH)))
  assert.match(err.message, /file path/)
  assert.match(err.message, /uuid/)
})

test('resolveSessionArg: rejects a short/malformed uuid', () => {
  assert.throws(() => resolveSessionArg(argv(BAD_UUID_SHORT)), /must be a session uuid/)
})

test('resolveSessionArg: rejects a plain string that is not a uuid', () => {
  assert.throws(() => resolveSessionArg(argv('not-a-uuid')), /must be a session uuid/)
})

test('resolveSessionArg: missing arg throws a usage sentence, not a crash', () => {
  // The smoke-ui.mjs variant of NF41: missing arg → raw ERR_INVALID_ARG_TYPE.
  const err = throws(() => resolveSessionArg(argv(), { caller: 'detail01.mjs' }))
  assert.match(err.message, /required/)
  assert.match(err.message, /node detail01\.mjs <session-uuid>/)
})

test('resolveSessionArg: empty-string arg is treated as absent', () => {
  assert.throws(() => resolveSessionArg(argv('')), /required/)
})

test('resolveSessionArg: absolute path rejected with file-path hint', () => {
  assert.throws(() => resolveSessionArg(argv('/home/user/env.json')), /file path/)
})

test('resolveSessionArg: rejects a number string (wrong type)', () => {
  assert.throws(() => resolveSessionArg(argv('1680')), /must be a session uuid/)
})

test('resolveSessionArg: bad argv type throws TypeError', () => {
  assert.throws(() => resolveSessionArg('not-an-array'), /argv must be an array/)
})

test('resolveSessionArg: slot < 2 throws TypeError', () => {
  assert.throws(() => resolveSessionArg(argv(GOOD_UUID), { slot: 1 }), /slot must be an integer >= 2/)
})

test('resolveSessionArg: slot = 3 reads the correct argv position', () => {
  // slot 3 = second positional; slot 2 has a dialog name, slot 3 has the uuid
  assert.equal(
    resolveSessionArg(['/n', '/s', 'SPAWN-01', GOOD_UUID], { slot: 3 }),
    GOOD_UUID,
  )
  // Slot 2 holds a non-uuid; slot 3 is what we validate.
  assert.throws(
    () => resolveSessionArg(['/n', '/s', GOOD_UUID, FILE_PATH], { slot: 3 }),
    /file path/,
  )
})

test('resolveSessionArg: caller name appears in the error sentence', () => {
  const err = throws(() => resolveSessionArg(argv(FILE_PATH), { caller: 'detail01.mjs' }))
  assert.match(err.message, /detail01\.mjs/)
})

test('resolveSessionArg: slot beyond argv length is treated as absent', () => {
  assert.throws(() => resolveSessionArg(argv(GOOD_UUID), { slot: 5 }), /required/)
})

// ── resolveViewportWidth ───────────────────────────────────────────────────

test('resolveViewportWidth: absent arg returns the fallback', () => {
  assert.equal(resolveViewportWidth(argv()), 1680)
})

test('resolveViewportWidth: a valid integer string is returned as a number', () => {
  assert.equal(resolveViewportWidth(argv('1280')), 1280)
})

test('resolveViewportWidth: custom fallback is used when absent', () => {
  assert.equal(resolveViewportWidth(argv(), { fallback: 1920 }), 1920)
})

test('resolveViewportWidth: rejects a file path — the nf37-verify.mjs NF41 bug', () => {
  // nf37-verify.mjs: Number('./env.json') === NaN → Playwright crash.
  const err = throws(() => resolveViewportWidth(argv(FILE_PATH), { caller: 'nf37-verify.mjs', name: 'viewport width' }))
  assert.match(err.message, /nf37-verify\.mjs/)
  assert.match(err.message, /viewport width/)
  assert.match(err.message, /file path/)
})

test('resolveViewportWidth: rejects a non-integer float', () => {
  assert.throws(() => resolveViewportWidth(argv('12.5')), /must be a positive integer/)
})

test('resolveViewportWidth: rejects zero', () => {
  assert.throws(() => resolveViewportWidth(argv('0')), /must be a positive integer/)
})

test('resolveViewportWidth: rejects a negative integer', () => {
  assert.throws(() => resolveViewportWidth(argv('-400')), /must be a positive integer/)
})

test('resolveViewportWidth: empty-string arg returns the fallback', () => {
  assert.equal(resolveViewportWidth(argv('')), 1680)
})

test('resolveViewportWidth: bad argv type throws TypeError', () => {
  assert.throws(() => resolveViewportWidth('not-an-array'), /argv must be an array/)
})

test('resolveViewportWidth: slot < 2 throws TypeError', () => {
  assert.throws(() => resolveViewportWidth(argv('1680'), { slot: 0 }), /slot must be an integer >= 2/)
})

test('resolveViewportWidth: NaN string produces a clear error mentioning NaN', () => {
  // Belt-and-suspenders: Number('abc') is NaN; the message must say so.
  const err = throws(() => resolveViewportWidth(argv('abc')))
  assert.match(err.message, /NaN/)
})

test('resolveViewportWidth: caller name appears in the error sentence', () => {
  const err = throws(() => resolveViewportWidth(argv('./env.json'), { caller: 'nf37-verify.mjs' }))
  assert.match(err.message, /nf37-verify\.mjs/)
})
