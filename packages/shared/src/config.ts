import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'

/**
 * Runtime config for orchestron API server.
 *
 * Precedence (highest wins):
 *   1. process.env (via env-var mapping)
 *   2. ~/.orchestron/config.json
 *   3. Built-in defaults
 *
 * Boot guard: bind non-loopback + no ORCHESTRON_REMOTE_TOKEN → refuse to start.
 */

export const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

const DEFAULT_MAX_CONCURRENT_CAP = 20
const RAM_PER_SUBPROCESS_MB = 800

/**
 * Global default for the headless kill switch.
 *
 * `true` — headless is available and the per-project / per-session
 * `useTmux` toggles decide. Set `enableHeadlessMode: false` in
 * ~/.orchestron/config.json to disable headless fleet-wide without
 * touching a single session record.
 */
export const DEFAULT_ENABLE_HEADLESS_MODE = true

/**
 * Global default for structured headless output (the `inquiry` schema).
 *
 * On, because an agent that cannot ask a question is the single biggest gap
 * between a headless session and a tmux one.
 */
export const DEFAULT_HEADLESS_STRUCTURED_OUTPUT = true

export const ConfigSchema = z.object({
  bindHost: z.string().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(8080),
  dataDir: z.string(),
  maxConcurrent: z.number().int().min(1).max(200),
  remoteToken: z.string().optional(),
  adapters: z
    .object({
      claude: z.boolean().default(true),
      codex: z.boolean().default(false),
      opencode: z.boolean().default(false),
    })
    .default({ claude: true, codex: false, opencode: false }),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  /** Milliseconds a session may stay idle/needs_input before its tmux is
   *  released (transition to 'sleeping'). 0 disables the sweeper. */
  idleTimeoutMs: z.number().int().min(0).default(15 * 60 * 1000),
  /** Global kill switch for headless mode. `false` makes the API refuse
   *  every explicit `useTmux: false` request and coerces headless project
   *  defaults back to tmux — an operator escape hatch for when a headless
   *  bug is loose in production. Default `true`: the per-session and
   *  per-project toggles behave exactly as they did before this flag. */
  enableHeadlessMode: z.boolean().default(DEFAULT_ENABLE_HEADLESS_MODE),
  /** Whether headless runs are given the structured-output schema that
   *  carries the `inquiry` field. `true` (default) is what lets a headless
   *  agent ask the user a question and land in `needs_input`.
   *
   *  Turning it off is the escape hatch for the one real cost: with the
   *  schema on, a turn's `finalResponse` is the model's *summary* of its
   *  answer rather than the answer's prose. The full text is still in the
   *  transcript, but a workflow that reads `finalResponse` as the deliverable
   *  wants this off. Headless then behaves as it did in Phase 1 — minus the
   *  ability to raise an inquiry. */
  headlessStructuredOutput: z.boolean().default(DEFAULT_HEADLESS_STRUCTURED_OUTPUT),
})

export type Config = z.infer<typeof ConfigSchema>

/**
 * Global default for the tmux/headless toggle.
 *
 * tmux (interactive TUI) is the default because it is what every session
 * predating the toggle actually used, and because it is the only mode that
 * supports live attach, sleeping/wake and the blocking `wait_for_idle` MCP
 * tool. Headless is strictly opt-in.
 */
export const DEFAULT_USE_TMUX = true

/**
 * Resolve the effective tmux/headless choice from the two optional layers
 * (per-spawn override > project default > global default).
 *
 * This exists so no consumer hand-rolls the check. `undefined` MUST mean
 * tmux: session records and project records written before the toggle
 * existed have no field at all, and a bare `!useTmux` / `Boolean(useTmux)`
 * test would flip every one of them to headless. Always nullish-coalesce.
 */
export function resolveUseTmux(
  sessionOrSpawn?: boolean | null,
  projectDefault?: boolean | null,
): boolean {
  return sessionOrSpawn ?? projectDefault ?? DEFAULT_USE_TMUX
}

/** True when the given record/config should run headless. Inverse of
 *  `resolveUseTmux`, spelled out so call sites read as intent. */
export function isHeadless(
  sessionOrSpawn?: boolean | null,
  projectDefault?: boolean | null,
): boolean {
  return !resolveUseTmux(sessionOrSpawn, projectDefault)
}

/** Body the API returns when a caller explicitly asks for headless while
 *  the global switch is off. Exported so route, tests and docs cannot
 *  drift from each other. */
export const HEADLESS_DISABLED_ERROR = 'headless mode disabled globally'
export const HEADLESS_DISABLED_HINT =
  'set enableHeadlessMode: true in ~/.orchestron/config.json'

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host)
}

export function autoMaxConcurrent(): number {
  const totalMemMb = os.totalmem() / (1024 * 1024)
  const computed = Math.floor(totalMemMb / RAM_PER_SUBPROCESS_MB)
  return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENT_CAP, computed))
}

function defaultDataDir(): string {
  return path.join(os.homedir(), '.orchestron')
}

function readConfigFile(configPath: string): unknown {
  if (!fs.existsSync(configPath)) return {}
  try {
    // Warn (not fatal) when config.json — which holds the plaintext
    // remoteToken — is group/world-readable on a POSIX filesystem. Any
    // local user on a shared host can otherwise lift the bearer.
    // Fatal-refuse would break existing single-user deploys, so keep it
    // to a stderr warning. Windows / non-POSIX perms are ignored (mode
    // reads as 0o666 there — noisy false positive).
    if (process.platform !== 'win32') {
      try {
        const st = fs.statSync(configPath)
        const worldGroupBits = st.mode & 0o077
        if (worldGroupBits !== 0) {
          const modeStr = (st.mode & 0o777).toString(8).padStart(3, '0')
          console.warn(
            `[orchestron] SECURITY: ${configPath} mode is 0${modeStr} — remoteToken is readable by other local users. Run: chmod 600 ${configPath}`,
          )
        }
      } catch { /* stat failed — skip warning */ }
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'))
  } catch (err) {
    throw new Error(`invalid config file ${configPath}: ${(err as Error).message}`)
  }
}

function envOverrides(env: NodeJS.ProcessEnv): Partial<Config> {
  const out: Partial<Config> = {}
  if (env.ORCHESTRON_BIND_HOST) out.bindHost = env.ORCHESTRON_BIND_HOST
  if (env.ORCHESTRON_PORT) out.port = Number(env.ORCHESTRON_PORT)
  if (env.ORCHESTRON_DATA_DIR) out.dataDir = env.ORCHESTRON_DATA_DIR
  if (env.ORCHESTRON_MAX_CONCURRENT) out.maxConcurrent = Number(env.ORCHESTRON_MAX_CONCURRENT)
  if (env.ORCHESTRON_IDLE_TIMEOUT_MS) out.idleTimeoutMs = Number(env.ORCHESTRON_IDLE_TIMEOUT_MS)
  if (env.ORCHESTRON_REMOTE_TOKEN) out.remoteToken = env.ORCHESTRON_REMOTE_TOKEN
  if (env.ORCHESTRON_LOG_LEVEL) {
    out.logLevel = env.ORCHESTRON_LOG_LEVEL as Config['logLevel']
  }

  // Backward-compat with legacy AHQ_* env vars from initial scaffold
  if (!out.port && env.AHQ_API_PORT) out.port = Number(env.AHQ_API_PORT)
  if (!out.dataDir && env.AHQ_DATA_DIR) out.dataDir = env.AHQ_DATA_DIR

  return out
}

export function loadConfig(opts: {
  configPath?: string
  env?: NodeJS.ProcessEnv
} = {}): Config {
  const env = opts.env ?? process.env
  const configPath = opts.configPath ?? path.join(defaultDataDir(), 'config.json')

  const fileRaw = readConfigFile(configPath) as Record<string, unknown>
  const envRaw = envOverrides(env)

  const merged: Record<string, unknown> = {
    dataDir: defaultDataDir(),
    maxConcurrent: autoMaxConcurrent(),
    ...fileRaw,
    ...envRaw,
  }

  return ConfigSchema.parse(merged)
}

/**
 * Boot guard — throws if binding to a non-loopback address without a remote token.
 * Call this synchronously before server.listen().
 */
export class BootGuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BootGuardError'
  }
}

export function assertSafeBind(cfg: Config): void {
  if (!isLoopback(cfg.bindHost) && !cfg.remoteToken) {
    throw new BootGuardError(
      `refusing to bind to ${cfg.bindHost} without ORCHESTRON_REMOTE_TOKEN. ` +
        `Either bind to 127.0.0.1 or set the env var. See docs/auth.md.`,
    )
  }
}
