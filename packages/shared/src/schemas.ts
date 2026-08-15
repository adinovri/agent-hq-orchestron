import { z } from 'zod'

export const AgentTypeSchema = z.enum(['claude', 'codex', 'opencode'])

export const SessionStatusSchema = z.enum(['active', 'waiting', 'completed', 'failed'])

export const SessionMetadataSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  agentType: AgentTypeSchema,
  status: SessionStatusSchema,
  parentSessionId: z.string().uuid().nullable(),
  claudeSessionUuid: z.string().uuid(),
  tmuxName: z.string(),
  jsonlPath: z.string(),
  initialPrompt: z.string(),
  finalResponse: z.string().nullable(),
  tokenUsage: z.object({ input: z.number(), output: z.number() }).nullable(),
  costUsd: z.number().nullable(),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  metadata: z.record(z.unknown()),
})

export const ProjectMetadataSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  path: z.string().min(1),
  agentType: AgentTypeSchema,
  createdAt: z.string().datetime(),
  config: z.record(z.unknown()),
})

export const DelegationEdgesSchema = z.object({
  version: z.literal(1),
  edges: z.array(z.object({
    parent: z.string().uuid(),
    child: z.string().uuid(),
    createdAt: z.string().datetime(),
  })),
})

export const SpawnSessionBodySchema = z.object({
  projectId: z.string().uuid(),
  agentType: AgentTypeSchema,
  prompt: z.string().min(1),
  parentSessionId: z.string().uuid().optional(),
})

export const RegisterProjectBodySchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  agentType: AgentTypeSchema,
  config: z.record(z.unknown()).optional(),
})
