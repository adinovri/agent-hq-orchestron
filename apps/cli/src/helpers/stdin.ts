/**
 * Read a prompt body from stdin when `--prompt` was not given.
 *
 * Long prompts do not belong on an argv line: shells cap it, quoting mangles
 * newlines, and the whole point of the CLI is that a workflow driver can pipe
 * a heredoc in. The rule is deliberately narrow — stdin is consulted only when
 * the flag is absent AND stdin is not a TTY, so an interactive
 * `orchestron session send <id>` with a forgotten flag errors immediately
 * instead of hanging on a terminal nobody is typing into.
 */
export async function readPromptOrStdin(
  flagValue: string | undefined,
  stdin: NodeJS.ReadStream = process.stdin,
): Promise<string | undefined> {
  if (flagValue !== undefined) return flagValue
  if (stdin.isTTY) return undefined

  const chunks: Buffer[] = []
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  // A trailing newline from a heredoc is punctuation, not content; anything
  // that is only whitespace is the same as no input at all.
  const trimmed = text.replace(/\n+$/, '')
  return trimmed.trim().length > 0 ? trimmed : undefined
}

/** `--prompt` is required for this command; say which ways it can arrive. */
export function requirePrompt(value: string | undefined, command: string): string {
  if (value !== undefined && value.trim().length > 0) return value
  throw new Error(`${command} needs a prompt — pass --prompt "…" or pipe one on stdin`)
}
