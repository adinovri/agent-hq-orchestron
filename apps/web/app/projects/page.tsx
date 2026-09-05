'use client'

import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { ProjectDialog } from '@/components/ProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'
import { fetchJson } from '@/lib/fetcher'
import { formatRelative } from '@/lib/time'
import { Skeleton } from '@/components/Skeleton'
import type { ProjectMetadata, SessionMetadata } from '@agent-hq-orchestron/shared'
import {
  Plus, FolderKanban, Search, Sparkles, Terminal, Bot,
  Pencil, Trash2, Inbox,
} from 'lucide-react'

const AGENT_ICON: Record<string, React.ReactNode> = {
  claude: <Sparkles className="w-4 h-4" />,
  codex: <Bot className="w-4 h-4" />,
  opencode: <Terminal className="w-4 h-4" />,
}

function ProjectCardSkeleton() {
  return (
    <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Skeleton className="w-9 h-9 rounded-lg" />
        <Skeleton className="h-5 w-32" />
      </div>
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-3 w-1/2" />
    </div>
  )
}

export default function ProjectsPage() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [editProject, setEditProject] = useState<ProjectMetadata | null>(null)
  const [deleteProject, setDeleteProject] = useState<ProjectMetadata | null>(null)

  const { data: projects = [], isLoading } = useQuery<ProjectMetadata[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const r = await fetchJson<{ projects: ProjectMetadata[] }>('/api/projects')
      return r.projects
    },
    refetchInterval: 10_000,
  })

  const { data: sessions = [] } = useQuery<SessionMetadata[]>({
    queryKey: ['sessions'],
    queryFn: async () => {
      const r = await fetchJson<{ sessions: SessionMetadata[] }>('/api/sessions')
      return r.sessions
    },
    refetchInterval: 15_000,
  })

  const sessionCountByProject = useMemo(() => {
    const map = new Map<string, { total: number; active: number }>()
    for (const s of sessions) {
      const cur = map.get(s.projectId) ?? { total: 0, active: 0 }
      cur.total += 1
      if (['spawning', 'waiting', 'running', 'needs_input', 'idle', 'completing'].includes(s.status)) {
        cur.active += 1
      }
      map.set(s.projectId, cur)
    }
    return map
  }, [sessions])

  const allGroups = useMemo(
    () => Array.from(new Set(projects.map((p) => p.group).filter(Boolean) as string[])),
    [projects],
  )

  const allTags = useMemo(
    () => Array.from(new Set(projects.flatMap((p) => p.tags ?? []))),
    [projects],
  )

  const filtered = useMemo(() => {
    return projects.filter((p) => {
      if (search && !p.name.toLowerCase().includes(search.toLowerCase()) &&
          !p.path.toLowerCase().includes(search.toLowerCase())) return false
      if (groupFilter && p.group !== groupFilter) return false
      if (tagFilter.length && !tagFilter.every((t) => p.tags?.includes(t))) return false
      return true
    })
  }, [projects, search, groupFilter, tagFilter])

  function invalidate() {
    qc.invalidateQueries({ queryKey: ['projects'] })
  }

  function toggleTag(tag: string) {
    setTagFilter((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-zinc-500 mt-0.5">
            {projects.length} registered
            {sessions.length > 0 && ` · ${sessions.length} sessions total`}
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="shrink-0">
          <Plus className="w-4 h-4 mr-1" /> Register
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            type="text"
            placeholder="Search name or path…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-8 pr-3 w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
        </div>

        {allGroups.length > 0 && (
          <select
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            className="h-9 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
          >
            <option value="">All groups</option>
            {allGroups.map((g) => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>
        )}
      </div>

      {allTags.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {allTags.map((tag) => (
            <button
              key={tag}
              type="button"
              onClick={() => toggleTag(tag)}
              className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                tagFilter.includes(tag)
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-500'
              }`}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* Cards */}
      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <ProjectCardSkeleton key={i} />)}
        </div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center bg-white dark:bg-zinc-900 border border-dashed border-zinc-300 dark:border-zinc-700 rounded-lg">
          <FolderKanban className="w-10 h-10 text-zinc-300 dark:text-zinc-600 mb-3" />
          <h2 className="text-base font-medium mb-1">No projects yet</h2>
          <p className="text-sm text-zinc-500 max-w-xs mb-4">
            Register a project (a git repo or working directory) to start spawning agent sessions on it.
          </p>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="w-4 h-4 mr-1" /> Register your first project
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-zinc-500">
          <Inbox className="w-8 h-8 text-zinc-300 dark:text-zinc-600 mb-2" />
          <p className="text-sm">No projects match your filters</p>
          <button
            onClick={() => { setSearch(''); setGroupFilter(''); setTagFilter([]) }}
            className="mt-2 text-xs text-blue-600 hover:underline"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filtered.map((project) => {
            const counts = sessionCountByProject.get(project.id) ?? { total: 0, active: 0 }
            const icon = AGENT_ICON[project.agentType] ?? <Bot className="w-4 h-4" />
            return (
              <div
                key={project.id}
                className="group bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 hover:border-zinc-300 dark:hover:border-zinc-700 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-lg bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center text-zinc-700 dark:text-zinc-200">
                    {icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">{project.name}</h3>
                      <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => setEditProject(project)}
                          className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                          title="Edit"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteProject(project)}
                          className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950 text-zinc-500 hover:text-red-600"
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 font-mono mt-0.5 truncate">
                      {project.path}
                    </p>
                    {(project.defaultModel || project.defaultEffort) && (
                      <div className="mt-1 flex items-center gap-1 flex-wrap">
                        {project.defaultModel && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-mono">
                            {project.defaultModel}
                          </span>
                        )}
                        {project.defaultEffort && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 font-mono uppercase">
                            effort:{project.defaultEffort}
                          </span>
                        )}
                      </div>
                    )}
                    {(project.tags ?? []).length > 0 && (
                      <div className="mt-2 flex gap-1 flex-wrap">
                        {(project.tags ?? []).map((tag) => (
                          <span
                            key={tag}
                            className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="mt-2 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 flex-wrap">
                      {project.group && (
                        <>
                          <span>{project.group}</span>
                          <span className="text-zinc-300 dark:text-zinc-700">·</span>
                        </>
                      )}
                      <span>Created {formatRelative(project.createdAt)}</span>
                      {counts.total > 0 && (
                        <>
                          <span className="text-zinc-300 dark:text-zinc-700">·</span>
                          <span>
                            {counts.total} sessions
                            {counts.active > 0 && (
                              <span className="ml-1 text-emerald-600 dark:text-emerald-400 font-medium">
                                ({counts.active} active)
                              </span>
                            )}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        project={null}
        onSaved={invalidate}
      />

      <ProjectDialog
        open={!!editProject}
        onClose={() => setEditProject(null)}
        project={editProject}
        onSaved={invalidate}
      />

      <DeleteProjectDialog
        project={deleteProject}
        onClose={() => setDeleteProject(null)}
        onDeleted={invalidate}
      />
    </div>
  )
}
