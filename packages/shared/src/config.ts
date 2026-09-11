import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { z } from 'zod'

/**
 * Runtime config for orchestron API server.
 *
 * Precedence (highest wins):
 *   1. process.env (via env-var mapping)
 *   2. the config file — `~/.orchestron/config.json` unless
 *      `ORCHESTRON_CONFIG` or `ORCHESTRON_DATA_DIR` moves it; see
 *      `resolveConfigPath`
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
 *
 * The switch *masks* rather than *guards*: with it off, a headless request
 * is silently coerced to tmux and the spawn succeeds. Nothing 400s and no
 * stored preference is rewritten, so flipping the switch back on restores
 * every project and session to the mode it actually asked for.
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
  /** Global kill switch for headless mode. `false` coerces every headless
   *  request — explicit `useTmux: false`, a headless project default, a
   *  headless session record — back to tmux, and hides the toggle in the
   *  UI. An operator escape hatch for when a headless bug is loose in
   *  production. Default `true`: the per-session and per-project toggles
   *  behave exactly as they did before this flag. */
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

/**
 * Machine-readable reason attached to a coerced response and logged
 * alongside it. Exported so route, session-manager and tests cannot drift
 * from each other.
 *
 * This is a wire value, not display copy — nobody is shown this string.
 * The toast wording lives in `apps/web/lib/notice.ts` with the rest of the
 * app's UI copy, because importing a runtime value from this module into a
 * client component pulls `node:fs` (via loadConfig below) into the browser
 * bundle.
 */
export const HEADLESS_COERCED_REASON = 'headless disabled globally'

/**
 * Advertised on a mutation response whose `useTmux` the server changed on
 * the caller's behalf. Absent when nothing was coerced, so a client can
 * treat presence alone as "show the notice".
 *
 * `useTmux` is always `true` — tmux is the only direction this switch
 * coerces — but it is spelled out rather than implied so the payload reads
 * the same as the field it is talking about.
 */
export interface HeadlessCoercion {
  useTmux: true
  reason: typeof HEADLESS_COERCED_REASON
}

/** The coercion payload, or `undefined` when nothing needed coercing.
 *  Single constructor so every route emits an identical shape. */
export function headlessCoercion(coerced: boolean): HeadlessCoercion | undefined {
  return coerced ? { useTmux: true, reason: HEADLESS_COERCED_REASON } : undefined
}

/**
 * The masking rule itself, in one place.
 *
 * Takes the mode a caller (or a stored record) asked for and the state of
 * the global switch, and returns the mode that will actually run plus
 * whether that involved overriding the request.
 *
 * `requested` is deliberately `boolean | undefined`: `undefined` means
 * "nobody expressed a preference", which resolves to tmux and is *not* a
 * coercion — only an explicit `false` that got turned into `true` counts,
 * because that is the only case worth telling the operator about.
 */
export function applyHeadlessSwitch(
  requested: boolean | undefined,
  headlessEnabled: boolean,
): { useTmux: boolean; coerced: boolean } {
  if (headlessEnabled) return { useTmux: resolveUseTmux(requested), coerced: false }
  return { useTmux: true, coerced: requested === false }
}

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

/** Basename of the config file inside a data dir. Exported so the E2E
 *  tooling and the web build can name the same file without repeating
 *  the string. */
export const CONFIG_FILENAME = 'config.json'

/**
 * Which `config.json` this process should read.
 *
 * Precedence (highest wins):
 *   1. an explicit path from the caller (tests pass one)
 *   2. `ORCHESTRON_CONFIG` — a full path to the file
 *   3. `<ORCHESTRON_DATA_DIR>/config.json` (or the legacy `AHQ_DATA_DIR`)
 *   4. `~/.orchestron/config.json`
 *
 * Arm 3 is the one that matters. `ORCHESTRON_DATA_DIR` already moved every
 * *record* a run writes, but the config file itself stayed pinned to
 * `~/.orchestron/config.json` — so a second instance pointed at its own
 * data dir still booted on the primary instance's port and, worse, its
 * bearer token. Deriving the config path from the data dir is what makes
 * "a whole second orchestron on this host" a matter of two env vars, which
 * is what the E2E environment needs.
 *
 * With neither env var set this returns exactly what the previous
 * hard-coded expression returned, so no existing deploy changes behaviour.
 */
export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string {
  if (explicit) return explicit
  if (env.ORCHESTRON_CONFIG) return env.ORCHESTRON_CONFIG
  const dataDir = env.ORCHESTRON_DATA_DIR || env.AHQ_DATA_DIR
  if (dataDir) return path.join(dataDir, CONFIG_FILENAME)
  return path.join(defaultDataDir(), CONFIG_FILENAME)
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

/**
 * The pre-`remoteToken` spelling of the bearer key in `config.json`.
 *
 * `orchestron token rotate` used to write `token`; the schema has always
 * read `remoteToken`. The result was a rotate that printed a fresh token,
 * reported success, and left the old bearer working — see B6-F1. The CLI
 * now writes `remoteToken`, and these two helpers carry the configs that
 * the broken version already wrote.
 */
export const LEGACY_TOKEN_KEY = 'token'

/**
 * Fold a legacy `token` key into `remoteToken` for this process.
 *
 * Read-only and side-effect free apart from the warning: it does not
 * touch the file, so it still works when the config lives on a read-only
 * mount or when the process cannot write as the owning user. The
 * persistent half is `migrateLegacyTokenKey`.
 *
 * `remoteToken` always wins when both keys are present — the key the API
 * has been reading all along is the one that is actually authenticating
 * clients right now, so adopting `token` instead would lock them out.
 */
export function applyLegacyTokenKey(
  raw: Record<string, unknown>,
  warn: (msg: string) => void = console.warn,
): Record<string, unknown> {
  const legacy = raw[LEGACY_TOKEN_KEY]
  if (typeof legacy !== 'string' || legacy.length === 0) return raw
  if (typeof raw.remoteToken === 'string' && raw.remoteToken.length > 0) {
    warn(
      `[orchestron] config has both "remoteToken" and the legacy "token" key — ` +
        `using "remoteToken" and ignoring "token". Delete the "token" key.`,
    )
    return raw
  }
  warn(
    `[orchestron] config key "token" is the legacy spelling of "remoteToken" — ` +
      `adopting it for this run. Run \`orchestron token rotate\` (or rename the key) ` +
      `to stop seeing this.`,
  )
  const out: Record<string, unknown> = { ...raw }
  out.remoteToken = legacy
  delete out[LEGACY_TOKEN_KEY]
  return out
}

/**
 * Rewrite a `config.json` that still uses the legacy `token` key, once.
 *
 * Call before `loadConfig` at boot. Idempotent: a config with no `token`
 * key, or one that already has a `remoteToken`, is left untouched (the
 * both-keys case is left to `applyLegacyTokenKey`, which prefers
 * `remoteToken` — rewriting there could silently swap the live bearer).
 *
 * A failed write is not fatal. `applyLegacyTokenKey` inside `loadConfig`
 * means the running process authenticates correctly either way; all that
 * is lost is the one-time cleanup.
 */
export function migrateLegacyTokenKey(
  opts: { configPath?: string; env?: NodeJS.ProcessEnv; warn?: (msg: string) => void } = {},
): { migrated: boolean; configPath: string; reason?: string } {
  const env = opts.env ?? process.env
  const warn = opts.warn ?? console.warn
  const configPath = resolveConfigPath(env, opts.configPath)

  if (!fs.existsSync(configPath)) return { migrated: false, configPath, reason: 'no config file' }

  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>
  } catch {
    return { migrated: false, configPath, reason: 'unparseable config' }
  }
  if (!raw || typeof raw !== 'object') return { migrated: false, configPath, reason: 'not an object' }

  const legacy = raw[LEGACY_TOKEN_KEY]
  if (typeof legacy !== 'string' || legacy.length === 0) {
    return { migrated: false, configPath, reason: 'no legacy token key' }
  }
  if (typeof raw.remoteToken === 'string' && raw.remoteToken.length > 0) {
    return { migrated: false, configPath, reason: 'remoteToken already set' }
  }

  const next: Record<string, unknown> = { ...raw, remoteToken: legacy }
  delete next[LEGACY_TOKEN_KEY]
  try {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
    // `mode` only applies when writeFileSync creates the file, and this
    // one already exists. Tighten it explicitly: we are rewriting a file
    // whose whole content is a plaintext bearer, and readConfigFile warns
    // about exactly this on every subsequent boot.
    if (process.platform !== 'win32') {
      try { fs.chmodSync(configPath, 0o600) } catch { /* best effort */ }
    }
  } catch (err) {
    warn(
      `[orchestron] could not rewrite ${configPath} to migrate "token" -> "remoteToken": ` +
        `${(err as Error).message}. The value is still honoured for this run.`,
    )
    return { migrated: false, configPath, reason: 'write failed' }
  }
  warn(
    `[orchestron] migrated legacy config key "token" -> "remoteToken" in ${configPath}.`,
  )
  return { migrated: true, configPath }
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
  const configPath = resolveConfigPath(env, opts.configPath)

  // Legacy `token` key -> `remoteToken`, in memory. Boot also rewrites the
  // file via `migrateLegacyTokenKey`, but this arm is what makes a config
  // the rewrite could not touch (read-only mount, wrong owner) still
  // authenticate — and what covers every non-server consumer of loadConfig.
  const fileRaw = applyLegacyTokenKey(readConfigFile(configPath) as Record<string, unknown>)
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
