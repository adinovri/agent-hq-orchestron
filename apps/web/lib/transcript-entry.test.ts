import { describe, it, expect } from 'vitest'
import { resumeMetaRole, RESUME_NUDGE, RESUME_NUDGE_REPLY } from './transcript-entry'

const user = (content: string) => ({ kind: 'user' as const, content })
const assistant = (content: string) => ({ kind: 'assistant' as const, content })

describe('resumeMetaRole', () => {
  it('marks the injected resume nudge', () => {
    expect(resumeMetaRole(user(RESUME_NUDGE))).toBe('nudge')
  })

  it('tolerates the whitespace a block join can leave', () => {
    expect(resumeMetaRole(user(`\n${RESUME_NUDGE}  `))).toBe('nudge')
  })

  it('marks the reply that immediately follows the nudge', () => {
    expect(resumeMetaRole(assistant(RESUME_NUDGE_REPLY), user(RESUME_NUDGE))).toBe('reply')
  })

  it('leaves the same reply alone when it does not follow a nudge', () => {
    // A model is allowed to write this sentence in a real answer. Without the
    // adjacency guard it would be greyed out as machinery.
    expect(resumeMetaRole(assistant(RESUME_NUDGE_REPLY), user('Say: No response requested.'))).toBeNull()
    expect(resumeMetaRole(assistant(RESUME_NUDGE_REPLY))).toBeNull()
    expect(resumeMetaRole(assistant(RESUME_NUDGE_REPLY), assistant(RESUME_NUDGE))).toBeNull()
  })

  it('leaves an operator turn that merely quotes the sentence alone', () => {
    expect(resumeMetaRole(user(`${RESUME_NUDGE} And then run the tests.`))).toBeNull()
    expect(resumeMetaRole(user('continue from where you left off.'))).toBeNull()
    expect(resumeMetaRole(user('Continue from where you left off'))).toBeNull()
  })

  it('never marks tool traffic', () => {
    expect(resumeMetaRole({ kind: 'tool_use', content: RESUME_NUDGE })).toBeNull()
    expect(resumeMetaRole({ kind: 'tool_result', content: RESUME_NUDGE_REPLY }, user(RESUME_NUDGE))).toBeNull()
  })

  it('classifies a whole five-turn transcript the way the sweep counted it', () => {
    // The NF8 measurement: 4 resume pairs among 18 entries. Each pair is two
    // meta entries; the operator's own turns and the agent's answers are not.
    const entries = [
      user('Remember the number 47. Reply with just: ok.'),
      assistant('ok'),
      user(RESUME_NUDGE),
      assistant(RESUME_NUDGE_REPLY),
      user('What number did I ask you to remember?'),
      assistant('47'),
      user(RESUME_NUDGE),
      assistant(RESUME_NUDGE_REPLY),
    ]
    const roles = entries.map((e, i) => resumeMetaRole(e, entries[i - 1]))
    expect(roles).toEqual([null, null, 'nudge', 'reply', null, null, 'nudge', 'reply'])
    expect(roles.filter(Boolean)).toHaveLength(4)
  })
})
