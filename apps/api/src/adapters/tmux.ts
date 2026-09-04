import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export async function newSession(name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  // tmux server env is inherited by new panes — use -e KEY=VAL to override per-session.
  // Client's process env doesn't propagate to attached server's pane processes.
  const envFlags: string[] = []
  if (env) {
    for (const [key, val] of Object.entries(env)) {
      if (val !== undefined && key !== 'PATH' && !key.startsWith('_')) {
        envFlags.push('-e', `${key}=${val}`)
      }
    }
  }
  await execFile('tmux', ['new-session', '-d', '-s', name, ...envFlags, '-c', cwd, ...argv])
}

export async function sendKeys(sessionName: string, keys: string): Promise<void> {
  await execFile('tmux', ['send-keys', '-t', sessionName, keys, ''])
}

export async function capturePane(sessionName: string): Promise<string> {
  const { stdout } = await execFile('tmux', [
    'capture-pane', '-p', '-t', sessionName,
  ])
  return stdout
}

export async function setBuffer(sessionName: string, text: string): Promise<void> {
  await execFile('tmux', ['set-buffer', '-t', sessionName, text])
}

export async function pasteBuffer(sessionName: string): Promise<void> {
  await execFile('tmux', ['paste-buffer', '-t', sessionName])
}

export async function killSession(sessionName: string): Promise<void> {
  try {
    await execFile('tmux', ['kill-session', '-t', sessionName])
  } catch {
    // session may already be gone
  }
}
