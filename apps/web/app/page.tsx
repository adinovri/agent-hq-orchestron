import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

const PLACEHOLDER_SESSIONS = [
  { id: "sess-001", agent: "claude", status: "active", project: "nanovest-bff", started: "2026-08-15 10:00" },
  { id: "sess-002", agent: "claude", status: "completed", project: "agent-hq-orchestron", started: "2026-08-15 09:30" },
  { id: "sess-003", agent: "codex", status: "waiting", project: "nanofutures-api", started: "2026-08-15 09:00" },
]

const STATUS_COLORS: Record<string, string> = {
  active: "text-green-600",
  waiting: "text-yellow-600",
  completed: "text-zinc-500",
  failed: "text-red-600",
}

export default function Dashboard() {
  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-zinc-950 p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">agent-hq-orchestron</h1>
            <p className="text-sm text-zinc-500 mt-1">Phase 0 scaffold — Phase 1 (CLI bridge) not yet started</p>
          </div>
          <Button disabled>+ Spawn Session</Button>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Active Sessions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">1</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Total Sessions</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">3</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-zinc-500">Projects</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">3</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sessions</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Agent</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PLACEHOLDER_SESSIONS.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.id}</TableCell>
                    <TableCell>{s.agent}</TableCell>
                    <TableCell>{s.project}</TableCell>
                    <TableCell className={STATUS_COLORS[s.status] ?? ""}>{s.status}</TableCell>
                    <TableCell className="text-xs text-zinc-500">{s.started}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" disabled>View</Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <p className="text-xs text-center text-zinc-400">
          Inspired by{" "}
          <a href="https://github.com/firewalker06/tycho" className="underline" target="_blank" rel="noopener noreferrer">
            Tycho
          </a>{" "}
          · MIT © 2026 Adi Novriansyah
        </p>
      </div>
    </div>
  )
}
