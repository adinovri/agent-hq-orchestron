import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export async function newSession(name: string, argv: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const envFlags: string[] = []
  if (env) {
    for (const [key, val] of Object.entries(env)) {
      if (val !== undefined && key !== 'PATH' && !key.startsWith('_')) {
        envFlags.push('-e', `${key}=${val}`)
      }
    }
  }

  const tmuxArgs = ['new-session', '-d', '-s', name, ...envFlags, '-c', cwd, ...argv]

  // When invoked from inside a systemd service scope, tmux's transient-scope creation
  // for pane cgroups is denied and the session dies within seconds. Wrap with
  // `systemd-run --user --scope` so tmux client runs in a fresh scope and its
  // spawned pane can create its own scope successfully.
  //
  // If systemd-run isn't available, fall back to plain tmux.
  try {
    await execFile('systemd-run', ['--user', '--scope', '--collect', 'tmux', ...tmuxArgs])
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('ENOENT') || msg.includes('command not found')) {
      await execFile('tmux', tmuxArgs)
    } else {
      throw err
    }
  }
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
