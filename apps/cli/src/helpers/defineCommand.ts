import type { Command } from 'commander'
import type { ZodSchema } from 'zod'

/** Add Zod-derived options to a Commander command with description hints. */
export function addZodOptions(cmd: Command, schema: ZodSchema): Command {
  const shape = (schema as { shape?: Record<string, { description?: string }> }).shape ?? {}
  for (const [key, field] of Object.entries(shape)) {
    const hint =
      (field as { description?: string }).description ?? `Value for ${key}`
    cmd.option(`--${key} <value>`, hint)
  }
  return cmd
}

export function jsonOut(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}
