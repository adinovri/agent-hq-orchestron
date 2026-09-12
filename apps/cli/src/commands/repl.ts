import type { Command } from 'commander'
import { createInterface } from 'node:readline'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pc from 'picocolors'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_ENTRY = join(__dirname, '../index.js')

const SUBCOMMANDS = [
  'session',
  'schedule',
  'project',
  'adopt',
  'doctor',
  'watch',
  'batch',
  'metrics',
  'help',
  'exit',
]

const ALIASES: Record<string, string> = {
  sess: 'session',
  sch: 'schedule',
}

const HISTORY_DIR = join(homedir(), '.orchestron')
const HISTORY_FILE = join(HISTORY_DIR, 'repl_history')
const MAX_HISTORY = 500

function loadHistory(): string[] {
  try {
    if (existsSync(HISTORY_FILE)) {
      return readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean)
    }
  } catch {
    /* ignore */
  }
  return []
}

function saveHistory(history: string[]): void {
  try {
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true })
    writeFileSync(HISTORY_FILE, history.slice(-MAX_HISTORY).join('\n') + '\n', 'utf8')
  } catch {
    /* ignore */
  }
}

/** Suggest nearest subcommand by prefix, then by single-char overlap. */
function suggest(input: string): string | null {
  const lower = input.toLowerCase()
  const byPrefix = SUBCOMMANDS.find((c) => c.startsWith(lower))
  if (byPrefix) return byPrefix
  // Check aliases
  const aliasMatch = Object.entries(ALIASES).find(([a]) => a.startsWith(lower))
  if (aliasMatch) return aliasMatch[1] ?? null
  return null
}

function runSubcommand(
  args: string[],
  passThroughOpts: string[],
  defaultProject: string | null,
): Promise<number> {
  return new Promise((resolve) => {
    const fullArgs = [...args, ...passThroughOpts]
    // Inject --project if set and not already specified
    if (defaultProject && !fullArgs.includes('--project') && !fullArgs.includes('-p')) {
      // Insert after the first subcommand token pair (e.g. 'session list')
      fullArgs.splice(2, 0, '--project', defaultProject)
    }

    const child = spawn(process.execPath, [CLI_ENTRY, ...fullArgs], {
      stdio: 'inherit',
    })
    child.on('close', (code) => resolve(code ?? 0))
    child.on('error', () => resolve(1))
  })
}

const REPL_HELP = `
${pc.bold('Orchestron REPL')}

Type any orchestron subcommand and press Enter to execute it.

${pc.bold('Subcommands:')}
  session   Manage sessions (alias: sess)
  schedule  Manage schedules (alias: sch)
  project   Manage projects
  doctor    Run diagnostics
  watch     Watch a session transcript
  batch     Batch operations
  metrics   Show metrics
  help      Show this help

${pc.bold('Special commands:')}
  .help                     Show this help
  .set default-project <id> Set a default --project for this session
  .exit / exit              Exit the REPL

${pc.bold('Shortcuts:')}
  Ctrl+C (once)   Cancel current input
  Ctrl+C (twice)  Exit REPL
  Ctrl+D          Exit REPL
  Arrow up/down   Navigate history

${pc.bold('Multi-line:')}
  End a line with \\ to continue on the next line.
`

export function registerRepl(program: Command): void {
  program
    .command('repl')
    .description('Start an interactive REPL shell (like psql/mongosh)')
    .option('--url <url>', 'API base URL')
    .option('--token <token>', 'Bearer token')
    .action(async (opts: { url?: string; token?: string }) => {
      const history = loadHistory()
      let defaultProject: string | null = null
      let ctrlCCount = 0
      let multiLineParts: string[] = []

      const passThroughOpts: string[] = []
      if (opts.url) passThroughOpts.push('--url', opts.url)
      if (opts.token) passThroughOpts.push('--token', opts.token)

      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        historySize: MAX_HISTORY,
        completer: (line: string): [string[], string] => {
          const tokens = line.trimStart().split(/\s+/)
          const first = tokens[0]?.toLowerCase() ?? ''
          // Complete first token from subcommands + aliases
          const completions = [
            ...SUBCOMMANDS,
            ...Object.keys(ALIASES),
            '.help',
            '.exit',
            '.set',
          ].filter((c) => c.startsWith(first))
          return [completions, first]
        },
      })

      // Inject saved history into readline
      for (const h of history) {
        ;(rl as unknown as { history: string[] }).history.unshift(h)
      }

      const promptStr = () =>
        defaultProject
          ? pc.green(`orchestron[${defaultProject}]> `)
          : pc.green('orchestron> ')

      function prompt(): void {
        rl.setPrompt(promptStr())
        rl.prompt()
      }

      process.stderr.write(
        pc.bold('Orchestron REPL') +
          pc.dim(' — type .help for help, .exit or Ctrl+D to quit\n'),
      )
      prompt()

      rl.on('SIGINT', () => {
        if (multiLineParts.length > 0) {
          multiLineParts = []
          process.stderr.write(pc.dim('\n[Cancelled]\n'))
          prompt()
          ctrlCCount = 0
          return
        }
        ctrlCCount++
        if (ctrlCCount >= 2) {
          process.stderr.write(pc.dim('\n[Exiting]\n'))
          saveHistory((rl as unknown as { history: string[] }).history.slice().reverse())
          rl.close()
          process.exit(0)
        }
        process.stderr.write(pc.dim('\n[Press Ctrl+C again or type .exit to quit]\n'))
        prompt()
        // Reset after timeout
        setTimeout(() => {
          ctrlCCount = 0
        }, 2000)
      })

      rl.on('close', () => {
        saveHistory((rl as unknown as { history: string[] }).history.slice().reverse())
        process.stderr.write('\n')
        process.exit(0)
      })

      rl.on('line', async (rawLine: string) => {
        rl.pause()
        ctrlCCount = 0

        // Multi-line continuation
        if (rawLine.endsWith('\\')) {
          multiLineParts.push(rawLine.slice(0, -1))
          rl.setPrompt(pc.green('... '))
          rl.prompt()
          rl.resume()
          return
        }

        const line = multiLineParts.length > 0
          ? multiLineParts.join(' ') + ' ' + rawLine
          : rawLine
        multiLineParts = []

        const trimmed = line.trim()
        if (!trimmed) {
          prompt()
          rl.resume()
          return
        }

        // Special dot-commands
        if (trimmed === '.help') {
          process.stdout.write(REPL_HELP)
          prompt()
          rl.resume()
          return
        }

        if (trimmed === '.exit' || trimmed === 'exit') {
          saveHistory((rl as unknown as { history: string[] }).history.slice().reverse())
          process.stderr.write(pc.dim('[Goodbye]\n'))
          rl.close()
          process.exit(0)
        }

        const setMatch = trimmed.match(/^\.set\s+default-project\s+(.+)$/)
        if (setMatch) {
          defaultProject = setMatch[1]!.trim()
          process.stdout.write(
            pc.green('✓') + ` default-project set to ${pc.bold(defaultProject)}\n`,
          )
          prompt()
          rl.resume()
          return
        }

        if (trimmed.startsWith('.')) {
          process.stderr.write(pc.red(`Unknown REPL command: ${trimmed}\n`))
          process.stderr.write(pc.dim('Type .help for available commands.\n'))
          prompt()
          rl.resume()
          return
        }

        // Parse as orchestron subcommand
        const parts = trimmed.split(/\s+/)
        const first = parts[0]!.toLowerCase()

        // Expand alias
        const expanded = ALIASES[first] ?? first

        if (!SUBCOMMANDS.includes(expanded) && expanded !== 'help') {
          const near = suggest(first)
          const hint = near ? pc.dim(` Did you mean ${pc.bold(near)}?`) : ''
          process.stderr.write(pc.red(`Unknown command: ${first}`) + hint + '\n')
          prompt()
          rl.resume()
          return
        }

        const cmdArgs = expanded === first ? parts : [expanded, ...parts.slice(1)]

        await runSubcommand(cmdArgs, passThroughOpts, defaultProject)

        prompt()
        rl.resume()
      })
    })
}
