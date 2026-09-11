import { z } from 'zod'

// ============================================================================
// Adapters
// ============================================================================

export const AgentTypeSchema = z.enum(['claude', 'codex', 'opencode'])
export const EffortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

// ============================================================================
// Session lifecycle — 7 states per HLD state diagram
// ============================================================================

export const SessionStatusSchema = z.enum([
  'spawning',
  'waiting',
  'running',
  'needs_input',
  'idle',
  'sleeping',
  'succeeded',
  'failed',
  'killed',
])

export const SessionMetadataSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  agentType: AgentTypeSchema,
  model: z.string().optional(),
  status: SessionStatusSchema,
  parentSessionId: z.string().uuid().nullable(),
  detached: z.boolean().default(false),
  claudeSessionUuid: z.string().uuid(),
  tmuxName: z.string(),
  jsonlPath: z.string(),
  initialPrompt: z.string(),
  finalResponse: z.string().nullable(),
  tokenUsage: z
    .object({
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().optional(),
      cacheCreation: z.number().optional(),
    })
    .nullable(),
  costUsd: z.number().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  configDir: z.string().optional(),
  cwdSlug: z.string().optional(),
  useTmux: z.boolean().optional(),
  pendingInquiry: z
    .object({
      message: z.string(),
      fields: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          type: z.enum(['text', 'choice', 'boolean']),
          options: z.array(z.string()).nullable(),
        }),
      ),
    })
    .nullable()
    .optional(),
  failureReason: z.string().optional(),
  metadata: z.record(z.unknown()),
})

// ============================================================================
// Projects
// ============================================================================

export const AgentConfigSchema = z.object({
  adapter: AgentTypeSchema.optional(),
  model: z.string().optional(),
  env: z.record(z.string()).optional(),
  extraArgs: z.array(z.string()).optional(),
  gitHost: z.enum(['gh', 'bb']).optional(),
})

export const ProjectMetadataSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  path: z.string().min(1),
  agentType: AgentTypeSchema,
  defaultModel: z.string().optional(),
  defaultEffort: EffortLevelSchema.optional(),
  defaultUseTmux: z.boolean().optional(),
  group: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  agentConfig: AgentConfigSchema.optional(),
  createdAt: z.string().datetime(),
  config: z.record(z.unknown()),
})

// ============================================================================
// Delegation
// ============================================================================

export const DelegationEdgeSchema = z.object({
  parent: z.string().uuid(),
  child: z.string().uuid(),
  spawnPrompt: z.string().optional(),
  createdAt: z.string().datetime(),
})

export const DelegationEdgesSchema = z.object({
  version: z.literal(1),
  edges: z.array(DelegationEdgeSchema),
})

// ============================================================================
// Snapshot (FR-23)
// ============================================================================

export const SnapshotSchema = z.object({
  sessionUuid: z.string().uuid(),
  prSource: z.string(), // e.g. "gh:pr:123" or "bb:pr:456"
  baseRef: z.string(),
  worktreePath: z.string(),
  readOnly: z.boolean().default(true),
  createdAt: z.string().datetime(),
})

// ============================================================================
// Prompt Templates (FR-17)
// ============================================================================

export const TemplateVariableSchema = z.object({
  type: z.enum(['string', 'number', 'boolean']),
  required: z.boolean().default(false),
  prompt: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
})

export const TemplateFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  variables: z.record(TemplateVariableSchema).optional(),
})

// ============================================================================
// Hooks (FR-16)
// ============================================================================

export const HookEventSchema = z.enum([
  'pre-spawn',
  'post-transcript-chunk',
  'on-session-end',
  'on-error',
  'on-schedule-fire',
])

export const HookInvocationSchema = z.object({
  id: z.string(),
  event: HookEventSchema,
  scriptPath: z.string(),
  sessionUuid: z.string().uuid().optional(),
  exitCode: z.number().int(),
  stderr: z.string(),
  durationMs: z.number().int(),
  firedAt: z.string().datetime(),
})

// ============================================================================
// Metrics (FR-18)
// ============================================================================

export const MetricsRecordSchema = z.object({
  sessionUuid: z.string().uuid(),
  projectId: z.string().uuid(),
  adapter: AgentTypeSchema,
  model: z.string().optional(),
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number().optional(),
    cacheCreation: z.number().optional(),
  }),
  costUsd: z.number(),
  durationMs: z.number(),
  endedAt: z.string().datetime(),
})

// ============================================================================
// API request bodies
// ============================================================================

export const SpawnSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  agentType: AgentTypeSchema.optional(),
  prompt: z.string().min(1).optional(),
  template: z.string().optional(),
  vars: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  parentSessionId: z.string().uuid().optional(),
  detached: z.boolean().optional(),
  snapshot: z.string().optional(), // e.g. "pr:123"
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  /** Omit to inherit the project default (which itself falls back to tmux).
   *  Explicit `false` spawns headless. */
  useTmux: z.boolean().optional(),
})

export const RegisterProjectBodySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  agentType: AgentTypeSchema,
  // `.min(1)` — an empty model string is not "no model", it is a model
  // named "" that every later spawn would try to pass to the harness.
  // Callers clearing a default send `null` on PATCH; see
  // PatchProjectBodySchema.
  defaultModel: z.string().min(1).optional(),
  defaultEffort: EffortLevelSchema.optional(),
  defaultUseTmux: z.boolean().optional(),
  group: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  agentConfig: AgentConfigSchema.optional(),
  config: z.record(z.unknown()).optional(),
})

/**
 * Body of `PATCH /api/projects/:id`.
 *
 * Every field of the register body, all optional, plus one addition:
 * `defaultModel`, `defaultEffort` and `agentConfig` also accept `null`,
 * meaning **unset this field**.
 *
 * Why `null` and not "omit it": the update is a shallow merge, so an
 * omitted key keeps whatever the record already had. That is the right
 * behaviour for a partial update and the wrong one for a form — the
 * project dialog omitted these keys whenever the user picked "harness
 * default", which made a project pinned to an expensive model
 * impossible to un-pin from the UI (B6-F2). Omission still merges, for
 * every API client written against the old shape; `null` is the new,
 * explicit clear.
 *
 * Empty string is still a 400. `null` is the clear; `""` is a typo.
 */
export const UNSETTABLE_PROJECT_FIELDS = ['defaultModel', 'defaultEffort', 'agentConfig'] as const

export const PatchProjectBodySchema = RegisterProjectBodySchema.partial().extend({
  defaultModel: z.string().min(1).nullable().optional(),
  defaultEffort: EffortLevelSchema.nullable().optional(),
  agentConfig: AgentConfigSchema.nullable().optional(),
})

// ============================================================================
// Cleanup ledger (SnapshotService boot scanner)
// ============================================================================

export const WorktreeLedgerSchema = z.object({
  sessionUuid: z.string().uuid(),
  worktreePath: z.string(),
  createdAt: z.string().datetime(),
})
