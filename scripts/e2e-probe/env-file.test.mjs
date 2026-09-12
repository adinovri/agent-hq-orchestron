/**
 * NF40's whole defect is invisible to a test that mocks fs: the probe read a
 * real file, just the wrong one. So these write real fixtures into a temp dir
 * and assert on WHICH path came back, the same way the sweep operator would
 * have found out in one second instead of three thirty-second timeouts.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveEnvFile, loadEnvFile, describeEnvFile, DEFAULT_ENV_FILE } from './env-file.mjs'

let dir, cwd0
const argv = (...args) => ['/usr/bin/node', '/probes/nf30.mjs', ...args]

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-probe-'))
  cwd0 = process.cwd()
  process.chdir(dir)
  // Two fixtures that name DIFFERENT sessions — the exact shape of the Kill
  // re-mint recipe. A probe reading the wrong one gets plausible JSON back.
  fs.writeFileSync('env.json', JSON.stringify({ sessionKill: 'stale-000', mintedFor: 'env.json' }))
  fs.writeFileSync('env-kill.json', JSON.stringify({ sessionKill: 'fresh-999', mintedFor: 'env-kill.json' }))
})
after(() => { process.chdir(cwd0); fs.rmSync(dir, { recursive: true, force: true }) })

test('the documented Kill recipe measures the fixture it names, not ./env.json', () => {
  // node nf30.mjs KillConfirmDialog ./env-kill.json
  const { file, env } = loadEnvFile(argv('KillConfirmDialog', './env-kill.json'), { positionals: 1 })
  assert.equal(file, './env-kill.json')
  assert.equal(env.sessionKill, 'fresh-999')
  // The NF40 bug, stated as an assertion: this is what the old probe returned.
  assert.notEqual(env.mintedFor, 'env.json')
})

test('nf26-shaped and nf30-shaped calls resolve the same argument slot', () => {
  const a = resolveEnvFile(argv('KillConfirmDialog', './env-kill.json'), { positionals: 1 })
  const b = resolveEnvFile(argv('./env-kill.json'), { positionals: 0 })
  assert.equal(a, './env-kill.json')
  assert.equal(b, './env-kill.json')
})

test('no argument still falls back to ./env.json', () => {
  const { file, env } = loadEnvFile(argv('KillConfirmDialog'), { positionals: 1 })
  assert.equal(file, DEFAULT_ENV_FILE)
  assert.equal(env.mintedFor, 'env.json')
  assert.equal(resolveEnvFile(argv(), { positionals: 0 }), DEFAULT_ENV_FILE)
})

test('an empty-string argument is treated as absent, not as a path', () => {
  assert.equal(resolveEnvFile(argv('KillConfirmDialog', ''), { positionals: 1 }), DEFAULT_ENV_FILE)
})

test('a fixture that is not there fails at the door, naming the path', () => {
  assert.throws(
    () => resolveEnvFile(argv('KillConfirmDialog', './env-never-minted.json'), { positionals: 1 }),
    /no fixture at \.\/env-never-minted\.json/,
  )
})

test('the fallback failing says it fell back, so the operator knows what to mint', () => {
  fs.rmSync('env.json')
  try {
    assert.throws(() => resolveEnvFile(argv('KillConfirmDialog'), { positionals: 1 }), /fell back to \.\/env\.json/)
  } finally {
    fs.writeFileSync('env.json', JSON.stringify({ sessionKill: 'stale-000', mintedFor: 'env.json' }))
  }
})

test('an argument the probe would not read is rejected, not ignored', () => {
  // This is NF40 turned into an error. Passing an env file to a probe that
  // declares 0 positionals used to be silently dropped.
  assert.throws(
    () => resolveEnvFile(argv('KillConfirmDialog', './env-kill.json'), { positionals: 0 }),
    /unread: \["\.\/env-kill\.json"\]/,
  )
})

test('mustExist:false skips the stat for callers that only want the path', () => {
  assert.equal(resolveEnvFile(argv('./nope.json'), { positionals: 0, mustExist: false }), './nope.json')
})

test('bad call shapes throw rather than resolving something plausible', () => {
  assert.throws(() => resolveEnvFile('not-an-array'), /argv must be an array/)
  assert.throws(() => resolveEnvFile(argv(), { positionals: -1 }), /non-negative integer/)
})

test('describeEnvFile names an absolute path and an age', () => {
  const line = describeEnvFile('./env-kill.json')
  assert.match(line, /^fixture: \//)
  assert.match(line, /env-kill\.json/)
  assert.match(line, /minted \d+s ago/)
  // A log line must not be able to fail the probe it is describing.
  assert.match(describeEnvFile('./does-not-exist.json'), /age unknown/)
})
