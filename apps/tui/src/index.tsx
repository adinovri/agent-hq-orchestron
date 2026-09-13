import React, { useState, useCallback, useEffect, useRef } from 'react'
import { render, Box, Text, useInput } from 'ink'
import { parseArgs } from 'node:util'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Header } from './components/Header.js'
import { StatusBar } from './components/StatusBar.js'
import { Dashboard } from './screens/Dashboard.js'
import { SessionDetail } from './screens/SessionDetail.js'
import { SpawnScreen } from './screens/SpawnScreen.js'
import { AdoptWizard } from './screens/AdoptWizard.js'
import { ImportWizard } from './screens/ImportWizard.js'
import { SchedulesScreen } from './screens/SchedulesScreen.js'
import { ScheduleWizard } from './screens/ScheduleWizard.js'
import { ProjectsScreen } from './screens/ProjectsScreen.js'
import { SettingsScreen } from './screens/SettingsScreen.js'
import { MetricsScreen } from './screens/MetricsScreen.js'
import { DiagnosticsScreen } from './screens/DiagnosticsScreen.js'
import { DelegationGraph } from './screens/DelegationGraph.js'
import { useApi } from './hooks/useApi.js'
import { useToast } from './hooks/useToast.js'
import { theme } from './hooks/useTheme.js'
import type { ApiConfig } from './hooks/useApi.js'

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    url: { type: 'string', default: 'http://localhost:8090' },
    token: { type: 'string' },
  },
  strict: false,
})

const BASE_URL = (values.url as string) ?? 'http://localhost:8090'
const TOKEN = values.token as string | undefined

const config: ApiConfig = { baseUrl: BASE_URL, token: TOKEN }

type Screen =
  | 'dashboard'
  | 'detail'
  | 'spawn'
  | 'adopt'
  | 'import'
  | 'schedules'
  | 'schedule-new'
  | 'projects'
  | 'settings'
  | 'metrics'
  | 'diagnostics'
  | 'delegation'

function App() {
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [selectedSession, setSelectedSession] = useState<SessionMetadata | null>(null)
  const [commandMode, setCommandMode] = useState(false)
  const [cmdInput, setCmdInput] = useState('')

  const { latest: toast, push: pushToast } = useToast(5000)

  const onStatus = useCallback(
    (msg: string, isError = false) => {
      pushToast(msg, isError ? 'error' : 'success')
    },
    [pushToast],
  )

  // Sessions poll for live-update notifications
  const { data: sessionsData, error: sessionsError, reconnecting } = useApi<{ sessions: SessionMetadata[] }>(
    '/api/sessions',
    config,
    3000,
  )
  const sessions = sessionsData?.sessions ?? []

  // Live-update: track needs_input changes
  const prevSessionsRef = useRef<SessionMetadata[]>([])
  useEffect(() => {
    const prev = prevSessionsRef.current
    if (prev.length === 0 && sessions.length > 0) {
      prevSessionsRef.current = sessions
      return
    }
    const prevIds = new Set(prev.map((s) => s.id))
    const newSessions = sessions.filter((s) => !prevIds.has(s.id))
    if (newSessions.length > 0) {
      pushToast(`New session started: ${newSessions[0].id.slice(0, 8)}`, 'info')
    }
    const needsInput = sessions.filter(
      (s) =>
        s.status === 'needs_input' &&
        prev.find((p) => p.id === s.id)?.status !== 'needs_input',
    )
    if (needsInput.length > 0) {
      pushToast(`Session ${needsInput[0].id.slice(0, 8)} needs input`, 'warn')
    }
    prevSessionsRef.current = sessions
  }, [sessions, pushToast])

  const onOpen = useCallback((session: SessionMetadata) => {
    setSelectedSession(session)
    setScreen('detail')
  }, [])

  const [diagUuid, setDiagUuid] = useState<string | null>(null)
  const [delegationUuid, setDelegationUuid] = useState<string | null>(null)

  const onBack = useCallback(() => {
    setSelectedSession(null)
    setDiagUuid(null)
    setDelegationUuid(null)
    setScreen('dashboard')
  }, [])

  const onBackToDetail = useCallback(() => {
    setDiagUuid(null)
    setDelegationUuid(null)
    setScreen('detail')
  }, [])

  const onDiagnostics = useCallback((uuid: string) => {
    setDiagUuid(uuid)
    setScreen('diagnostics')
  }, [])

  const onDelegation = useCallback((uuid: string) => {
    setDelegationUuid(uuid)
    setScreen('delegation')
  }, [])

  const onNew = useCallback(() => setScreen('spawn'), [])
  const onAdopt = useCallback(() => setScreen('adopt'), [])
  const onImport = useCallback(() => setScreen('import'), [])

  const onSpawnDone = useCallback(() => setScreen('dashboard'), [])
  const onQuit = useCallback(() => process.exit(0), [])

  const onBackToDashboard = useCallback(() => setScreen('dashboard'), [])

  // Global keybinds for top-level screen switching
  useInput(
    useCallback(
      (input) => {
        if (commandMode) return
        if (screen !== 'dashboard') return
        if (input === 'S') setScreen('schedules')
        else if (input === 'P') setScreen('projects')
        else if (input === ',') setScreen('settings')
        else if (input === 'm') setScreen('metrics')
        else if (input === 'A') onAdopt()
        else if (input === 'I') onImport()
      },
      [commandMode, screen, onAdopt, onImport],
    ),
  )

  // Command palette
  useInput(
    useCallback(
      (input, key) => {
        if (!commandMode) return
        if (key.escape) {
          setCommandMode(false)
          setCmdInput('')
        } else if (key.return) {
          const cmd = cmdInput.trim()
          if (cmd === 'quit' || cmd === 'q') process.exit(0)
          else if (cmd === 'dashboard') setScreen('dashboard')
          else if (cmd === 'spawn') setScreen('spawn')
          else if (cmd === 'adopt') setScreen('adopt')
          else if (cmd === 'import') setScreen('import')
          else if (cmd === 'metrics') setScreen('metrics')
          else if (cmd === 'schedules') setScreen('schedules')
          else if (cmd === 'projects') setScreen('projects')
          else if (cmd === 'settings') setScreen('settings')
          setCommandMode(false)
          setCmdInput('')
        } else if (key.backspace || key.delete) {
          setCmdInput((s) => s.slice(0, -1))
        } else if (input && !key.ctrl) {
          setCmdInput((s) => s + input)
        }
      },
      [commandMode, cmdInput],
    ),
  )

  const toastColor = toast
    ? { error: 'red', warn: 'yellow', info: theme.accent, success: theme.success }[toast.level]
    : theme.success

  return (
    <Box flexDirection="column" padding={0}>
      <Header baseUrl={BASE_URL} />

      {sessionsError && screen === 'dashboard' && (
        <Box paddingX={1}>
          <Text color="red">API error: {sessionsError}</Text>
        </Box>
      )}

      {screen === 'dashboard' && (
        <Dashboard
          sessions={sessions}
          config={config}
          onOpen={onOpen}
          onNew={onNew}
          onQuit={onQuit}
          onStatus={onStatus}
          commandMode={commandMode}
          setCommandMode={setCommandMode}
        />
      )}

      {screen === 'detail' && selectedSession && (
        <SessionDetail
          session={selectedSession}
          config={config}
          onBack={onBack}
          onStatus={onStatus}
          onDiagnostics={onDiagnostics}
          onDelegation={onDelegation}
        />
      )}

      {screen === 'diagnostics' && diagUuid && (
        <DiagnosticsScreen uuid={diagUuid} config={config} onBack={onBackToDetail} />
      )}

      {screen === 'delegation' && delegationUuid && (
        <DelegationGraph rootUuid={delegationUuid} config={config} onBack={onBackToDetail} />
      )}

      {screen === 'spawn' && (
        <SpawnScreen config={config} onDone={onSpawnDone} onStatus={onStatus} />
      )}

      {screen === 'adopt' && (
        <AdoptWizard config={config} onDone={onSpawnDone} onStatus={onStatus} />
      )}

      {screen === 'import' && (
        <ImportWizard config={config} onDone={onSpawnDone} onStatus={onStatus} />
      )}

      {screen === 'schedules' && (
        <SchedulesScreen
          config={config}
          onBack={onBackToDashboard}
          onNew={() => setScreen('schedule-new')}
        />
      )}

      {screen === 'schedule-new' && (
        <ScheduleWizard
          config={config}
          onDone={() => setScreen('schedules')}
          onStatus={onStatus}
        />
      )}

      {screen === 'projects' && (
        <ProjectsScreen config={config} onBack={onBackToDashboard} />
      )}

      {screen === 'settings' && (
        <SettingsScreen onBack={onBackToDashboard} />
      )}

      {screen === 'metrics' && (
        <MetricsScreen config={config} onBack={onBackToDashboard} />
      )}

      {commandMode && (
        <Box borderStyle="round" paddingX={1} marginTop={1}>
          <Text bold color="yellow">
            /{cmdInput}
          </Text>
          <Text color="gray">  (Esc to cancel, Enter to run)</Text>
        </Box>
      )}

      <StatusBar
        message={toast?.message ?? 'Ready'}
        level={toast?.level}
        reconnecting={reconnecting}
      />

      {/* Theme indicator (only when non-default) */}
      {theme.name !== 'default' && (
        <Box paddingX={1}>
          <Text color="gray" dimColor>theme: {theme.name}</Text>
        </Box>
      )}
    </Box>
  )
}

render(<App />)
