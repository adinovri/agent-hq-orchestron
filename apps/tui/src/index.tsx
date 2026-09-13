import React, { useState, useCallback } from 'react'
import { render, Box, Text, useInput } from 'ink'
import { parseArgs } from 'node:util'
import type { SessionMetadata } from '@agent-hq-orchestron/shared'
import { Header } from './components/Header.js'
import { StatusBar } from './components/StatusBar.js'
import { Dashboard } from './screens/Dashboard.js'
import { SessionDetail } from './screens/SessionDetail.js'
import { SpawnScreen } from './screens/SpawnScreen.js'
import { SchedulesScreen } from './screens/SchedulesScreen.js'
import { ProjectsScreen } from './screens/ProjectsScreen.js'
import { SettingsScreen } from './screens/SettingsScreen.js'
import { MetricsScreen } from './screens/MetricsScreen.js'
import { DiagnosticsScreen } from './screens/DiagnosticsScreen.js'
import { DelegationGraph } from './screens/DelegationGraph.js'
import { useApi } from './hooks/useApi.js'
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

type Screen = 'dashboard' | 'detail' | 'spawn' | 'schedules' | 'projects' | 'settings' | 'metrics' | 'diagnostics' | 'delegation'

function App() {
  const [screen, setScreen] = useState<Screen>('dashboard')
  const [selectedSession, setSelectedSession] = useState<SessionMetadata | null>(null)
  const [statusMsg, setStatusMsg] = useState('Ready')
  const [statusError, setStatusError] = useState(false)
  const [commandMode, setCommandMode] = useState(false)
  const [cmdInput, setCmdInput] = useState('')

  // API returns { sessions: [...] }, not a bare array (see CLI session list for same fix)
  const { data: sessionsData, error: sessionsError } = useApi<{ sessions: SessionMetadata[] }>(
    '/api/sessions',
    config,
    3000,
  )
  const sessions = sessionsData?.sessions ?? []

  const onStatus = useCallback((msg: string, isError = false) => {
    setStatusMsg(msg)
    setStatusError(isError)
  }, [])

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

  const onNew = useCallback(() => {
    setScreen('spawn')
  }, [])

  const onSpawnDone = useCallback(() => {
    setScreen('dashboard')
  }, [])

  const onQuit = useCallback(() => {
    process.exit(0)
  }, [])

  const onBackToDashboard = useCallback(() => {
    setScreen('dashboard')
  }, [])

  // Global keybinds for top-level screen switching (only when not in command mode or a sub-screen)
  useInput(
    useCallback(
      (input) => {
        if (commandMode) return
        if (screen !== 'dashboard') return
        if (input === 'S') setScreen('schedules')
        else if (input === 'P') setScreen('projects')
        else if (input === ',') setScreen('settings')
        else if (input === 'm') setScreen('metrics')
      },
      [commandMode, screen],
    ),
  )

  // Command palette input handling
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

      {screen === 'schedules' && (
        <SchedulesScreen config={config} onBack={onBackToDashboard} />
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

      <StatusBar message={statusMsg} isError={statusError} />
    </Box>
  )
}

render(<App />)
