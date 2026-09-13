import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface TuiTheme {
  name: string
  accent: string
  accentDim: string
  success: string
  warn: string
  error: string
  info: string
  muted: string
  highlight: string
  bg: string | undefined
}

const THEMES: Record<string, TuiTheme> = {
  default: {
    name: 'default',
    accent: 'cyan',
    accentDim: 'blue',
    success: 'green',
    warn: 'yellow',
    error: 'red',
    info: 'blue',
    muted: 'gray',
    highlight: 'white',
    bg: 'blue',
  },
  dark: {
    name: 'dark',
    accent: 'blueBright',
    accentDim: 'blue',
    success: 'greenBright',
    warn: 'yellowBright',
    error: 'redBright',
    info: 'cyanBright',
    muted: 'gray',
    highlight: 'whiteBright',
    bg: 'blue',
  },
  'high-contrast': {
    name: 'high-contrast',
    accent: 'whiteBright',
    accentDim: 'white',
    success: 'greenBright',
    warn: 'yellowBright',
    error: 'redBright',
    info: 'cyanBright',
    muted: 'white',
    highlight: 'whiteBright',
    bg: undefined,
  },
}

function loadTheme(): TuiTheme {
  const envName = process.env.ORCHESTRON_TUI_THEME
  if (envName && THEMES[envName]) return THEMES[envName]

  const configPath = join(homedir(), '.orchestron', 'tui-theme.json')
  if (existsSync(configPath)) {
    try {
      const raw = readFileSync(configPath, 'utf8')
      const obj = JSON.parse(raw) as { theme?: string }
      if (obj.theme && THEMES[obj.theme]) return THEMES[obj.theme]
    } catch {
      // ignore
    }
  }

  return THEMES.default
}

// Load once at startup — theme doesn't change mid-session
export const theme: TuiTheme = loadTheme()

export function useTheme(): TuiTheme {
  return theme
}
