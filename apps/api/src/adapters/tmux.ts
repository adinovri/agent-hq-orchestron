import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export async function newSession(name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const opts = env ? { env: { ...process.env, ...env } } : {}
  await execFile('tmux', ['new-session', '-d', '-s', name, '-c', cwd, ...argv], opts)
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
