import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FALLBACK_BASE, extractMessage, resolveApiBase, resolveToken } from '../src/helpers/api.js'
import { compact, parseBoolFlag, resolveUseTmux } from '../src/helpers/mode.js'
import { formatInquiryAnswer, matchOption, parseFieldAssignment, planAnswer } from '../src/helpers/answer.js'
import { bundleKind, collectRepeatable, parseVarAssignments } from '../src/helpers/files.js'
import { readPromptOrStdin, requirePrompt } from '../src/helpers/stdin.js'
import { toApiDate } from '../src/commands/metrics.js'

describe('resolveUseTmux — the tri-state', () => {
  it('returns undefined when neither flag is given', () => {
    // Load-bearing: undefined means "keep the session's own mode" on every
    // revival route. A boolean here would migrate headless sessions to tmux.
    expect(resolveUseTmux({})).toBeUndefined()
  })

  it('maps --headless to false and --tmux to true', () => {
    expect(resolveUseTmux({ headless: true })).toBe(false)
    expect(resolveUseTmux({ tmux: true })).toBe(true)
  })

  it('refuses both at once instead of picking a winner', () => {
    expect(() => resolveUseTmux({ headless: true, tmux: true })).toThrow(/mutually exclusive/)
  })
})

describe('parseBoolFlag', () => {
  it('accepts the spellings an operator actually types', () => {
    for (const yes of ['true', 'TRUE', 'yes', '1']) expect(parseBoolFlag(yes, '--x')).toBe(true)
    for (const no of ['false', 'No', '0']) expect(parseBoolFlag(no, '--x')).toBe(false)
  })

  it('passes undefined through — an omitted flag is not an edit', () => {
    expect(parseBoolFlag(undefined, '--x')).toBeUndefined()
  })

  it('rejects anything else rather than coercing', () => {
    expect(() => parseBoolFlag('maybe', '--use-tmux')).toThrow(/--use-tmux expects true or false/)
  })
})

describe('compact', () => {
  it('drops undefined but keeps false, null and empty string', () => {
    expect(compact({ a: undefined, b: false, c: null, d: '', e: 0 })).toEqual({ b: false, c: null, d: '', e: 0 })
  })
})

describe('matchOption', () => {
  const options = ['Yes, allow this', 'Yes, allow all', 'No, deny']

  it('takes a bare integer as the 1-based displayed position', () => {
    expect(matchOption('2', options)).toBe(2)
  })

  it('rejects an out-of-range number', () => {
    expect(() => matchOption('9', options)).toThrow(/out of range/)
  })

  it('matches unique text case-insensitively', () => {
    expect(matchOption('no, deny', options)).toBe(3)
  })

  it('refuses an ambiguous substring rather than taking the first', () => {
    // The consequence of guessing here is an approved permission.
    expect(() => matchOption('Yes', options)).toThrow(/ambiguous/)
  })

  it('lists the options when nothing matched', () => {
    expect(() => matchOption('zzz', options)).toThrow(/1\) Yes, allow this/)
  })

  it('prefers an exact match over a substring', () => {
    expect(matchOption('run', ['run', 'run tests'])).toBe(1)
  })
})

describe('planAnswer', () => {
  const prompt = {
    kind: 'permission' as const,
    title: 'Bash',
    options: ['Yes', 'No'],
    capturedAt: '2026-09-11T00:00:00.000Z',
  }

  it('routes a selector modal to the index endpoint', () => {
    expect(planAnswer({ pendingPrompt: prompt }, { choice: 'No' })).toEqual({ kind: 'prompt', index: 2, label: 'No' })
  })

  it('tells the operator the options when --choice is missing', () => {
    expect(() => planAnswer({ pendingPrompt: prompt }, {})).toThrow(/1\) Yes/)
  })

  it('routes a single-field inquiry to a text turn', () => {
    const inquiry = {
      message: 'Which env?',
      fields: [{ name: 'env', label: 'Environment', type: 'choice' as const, options: ['staging', 'production'] }],
    }
    // A single field answers bare — the agent asked one thing and gets the
    // answer, not a restatement of its own question.
    expect(planAnswer({ pendingInquiry: inquiry }, { choice: 'prod' })).toEqual({
      kind: 'inquiry',
      prompt: 'production',
    })
  })

  it('labels each answer when the inquiry has several fields', () => {
    const inquiry = {
      message: 'Details?',
      fields: [
        { name: 'env', label: 'Environment', type: 'text' as const, options: null },
        { name: 'ref', label: 'Git ref', type: 'text' as const, options: null },
      ],
    }
    expect(planAnswer({ pendingInquiry: inquiry }, { fields: ['env=stg', 'ref=main'] })).toEqual({
      kind: 'inquiry',
      prompt: 'Environment: stg\nGit ref: main',
    })
  })

  it('refuses --choice on a multi-field inquiry instead of filling the first', () => {
    const inquiry = {
      message: 'Details?',
      fields: [
        { name: 'a', label: 'A', type: 'text' as const, options: null },
        { name: 'b', label: 'B', type: 'text' as const, options: null },
      ],
    }
    expect(() => planAnswer({ pendingInquiry: inquiry }, { choice: 'x' })).toThrow(/--field name=value/)
  })

  it('names the fields left unanswered', () => {
    const inquiry = {
      message: 'Details?',
      fields: [
        { name: 'a', label: 'A', type: 'text' as const, options: null },
        { name: 'b', label: 'B', type: 'text' as const, options: null },
      ],
    }
    expect(() => planAnswer({ pendingInquiry: inquiry }, { fields: ['a=1'] })).toThrow(/unanswered field\(s\): b/)
  })

  it('rejects a field name the inquiry never asked for', () => {
    const inquiry = {
      message: 'Details?',
      fields: [{ name: 'a', label: 'A', type: 'text' as const, options: null }],
    }
    expect(() => planAnswer({ pendingInquiry: inquiry }, { fields: ['typo=1'] })).toThrow(/no field named "typo"/)
  })

  it('refuses when the session is waiting on nothing', () => {
    // Posting the choice text as a fresh user turn would look like it worked.
    expect(() => planAnswer({ status: 'idle' }, { choice: '1' })).toThrow(/no pending prompt or inquiry/)
  })

  it('--text skips option matching', () => {
    const inquiry = {
      message: 'Which?',
      fields: [{ name: 'x', label: 'X', type: 'choice' as const, options: ['a', 'b'] }],
    }
    expect(planAnswer({ pendingInquiry: inquiry }, { text: 'something else' })).toEqual({
      kind: 'inquiry',
      prompt: 'something else',
    })
  })
})

describe('formatInquiryAnswer', () => {
  it('throws when nothing was supplied', () => {
    expect(() => formatInquiryAnswer([{ name: 'a', label: 'A', type: 'text', options: null }], new Map())).toThrow(
      /no answers/,
    )
  })
})

describe('assignment parsers', () => {
  it('splits on the first = so values may contain one', () => {
    expect(parseFieldAssignment('note=a=b')).toEqual({ name: 'note', value: 'a=b' })
    expect(parseVarAssignments(['x=1', 'y=a=b'])).toEqual({ x: '1', y: 'a=b' })
  })

  it('rejects a pair with no name', () => {
    expect(() => parseFieldAssignment('=value')).toThrow(/name=value/)
    expect(() => parseVarAssignments(['nope'])).toThrow(/name=value/)
  })

  it('collects repeatable flags in order', () => {
    expect(collectRepeatable('b', collectRepeatable('a', []))).toEqual(['a', 'b'])
  })
})

describe('bundleKind', () => {
  it('recognises both bundle shapes and nothing else', () => {
    expect(bundleKind('s.jsonl')).toBe('jsonl')
    expect(bundleKind('s.tar.gz')).toBe('tar.gz')
    expect(bundleKind('s.tgz')).toBe('tar.gz')
    expect(bundleKind('s.txt')).toBe('unknown')
  })
})

describe('toApiDate', () => {
  it('truncates a full ISO timestamp to the date the endpoint accepts', () => {
    // Every other timestamp in the system is full ISO, including the ones a
    // caller copies out of `session list --json`.
    expect(toApiDate('2026-09-11T04:05:06.000Z', '--from')).toBe('2026-09-11')
  })

  it('passes a plain date through', () => {
    expect(toApiDate('2026-09-11', '--to')).toBe('2026-09-11')
  })

  it('treats an empty string as absent', () => {
    expect(toApiDate('', '--from')).toBeUndefined()
    expect(toApiDate(undefined, '--from')).toBeUndefined()
  })

  it('rejects a non-date before it reaches the wire', () => {
    expect(() => toApiDate('last tuesday', '--from')).toThrow(/YYYY-MM-DD/)
  })
})

describe('extractMessage', () => {
  it('unwraps a Fastify string error', () => {
    expect(extractMessage('{"error":"Session not found: x"}')).toBe('Session not found: x')
  })

  it('renders a zod flatten() object on one line', () => {
    expect(extractMessage('{"error":{"fieldErrors":{"cron":["invalid"]}}}')).toContain('fieldErrors')
  })

  it('falls back to the raw text for a non-JSON body', () => {
    expect(extractMessage('<html>502</html>')).toBe('<html>502</html>')
  })
})

describe('host and token resolution', () => {
  let dir: string
  let configPath: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-cli-'))
    configPath = path.join(dir, 'config.json')
    process.env.ORCHESTRON_CONFIG = configPath
    delete process.env.ORCHESTRON_URL
    delete process.env.ORCHESTRON_TOKEN
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('prefers --url, then $ORCHESTRON_URL, then config, then the fallback', () => {
    fs.writeFileSync(configPath, JSON.stringify({ bindHost: '100.82.168.18', port: 8090 }))
    expect(resolveApiBase({ url: 'http://flag:1' }, process.env)).toBe('http://flag:1')
    expect(resolveApiBase({}, { ...process.env, ORCHESTRON_URL: 'http://env:2' })).toBe('http://env:2')
    expect(resolveApiBase({}, process.env)).toBe('http://100.82.168.18:8090')
    fs.writeFileSync(configPath, '{}')
    expect(resolveApiBase({}, process.env)).toBe(FALLBACK_BASE)
  })

  it('accepts --host as the deprecated alias schedule shipped with', () => {
    expect(resolveApiBase({ host: 'http://legacy:3' }, process.env)).toBe('http://legacy:3')
  })

  it('strips a trailing slash so paths do not double up', () => {
    expect(resolveApiBase({ url: 'http://x:1/' }, process.env)).toBe('http://x:1')
  })

  it('survives a malformed config file', () => {
    fs.writeFileSync(configPath, 'not json at all')
    expect(resolveApiBase({}, process.env)).toBe(FALLBACK_BASE)
    expect(resolveToken({}, process.env)).toBeUndefined()
  })

  it('reads remoteToken, and the legacy token key as a fallback', () => {
    fs.writeFileSync(configPath, JSON.stringify({ remoteToken: 'new' }))
    expect(resolveToken({}, process.env)).toBe('new')
    // B6-F1 renamed the key; a config written before that still authenticates.
    fs.writeFileSync(configPath, JSON.stringify({ token: 'legacy' }))
    expect(resolveToken({}, process.env)).toBe('legacy')
    // remoteToken wins when both are present, as it does in the API.
    fs.writeFileSync(configPath, JSON.stringify({ token: 'legacy', remoteToken: 'new' }))
    expect(resolveToken({}, process.env)).toBe('new')
  })

  it('prefers the flag and then the env var over the file', () => {
    fs.writeFileSync(configPath, JSON.stringify({ remoteToken: 'file' }))
    expect(resolveToken({ token: 'flag' }, process.env)).toBe('flag')
    expect(resolveToken({}, { ...process.env, ORCHESTRON_TOKEN: 'env' })).toBe('env')
  })
})

describe('readPromptOrStdin', () => {
  function fakeStdin(text: string): NodeJS.ReadStream {
    async function* gen() {
      yield Buffer.from(text)
    }
    return Object.assign(gen(), { isTTY: false }) as unknown as NodeJS.ReadStream
  }

  it('returns the flag untouched without touching stdin', async () => {
    await expect(readPromptOrStdin('from flag', fakeStdin('from pipe'))).resolves.toBe('from flag')
  })

  it('reads the pipe when the flag is absent', async () => {
    await expect(readPromptOrStdin(undefined, fakeStdin('line one\nline two\n'))).resolves.toBe('line one\nline two')
  })

  it('treats a whitespace-only pipe as nothing', async () => {
    await expect(readPromptOrStdin(undefined, fakeStdin('   \n'))).resolves.toBeUndefined()
  })

  it('does not hang on an interactive terminal', async () => {
    const tty = { isTTY: true } as NodeJS.ReadStream
    await expect(readPromptOrStdin(undefined, tty)).resolves.toBeUndefined()
  })

  it('requirePrompt names both ways the prompt can arrive', () => {
    expect(() => requirePrompt(undefined, 'session send')).toThrow(/--prompt .* or pipe one on stdin/)
    expect(requirePrompt('x', 'session send')).toBe('x')
  })
})
