'use client'

import { useState, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table'
import { ProjectDialog } from '@/components/ProjectDialog'
import { DeleteProjectDialog } from '@/components/DeleteProjectDialog'
import { fetchJson } from '@/lib/fetcher'
import type { ProjectMetadata } from '@agent-hq-orchestron/shared'

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
    queryFn: () => fetchJson('/api/projects'),
    refetchInterval: 10_000,
  })

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
      if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false
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
    <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Projects</h1>
        <Button onClick={() => setCreateOpen(true)}>+ Register Project</Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap gap-3 items-center">
        <input
          type="text"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 px-3 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm w-52 focus:outline-none focus:ring-2 focus:ring-zinc-400"
        />

        <select
          value={groupFilter}
          onChange={(e) => setGroupFilter(e.target.value)}
          className="h-8 px-2 rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 text-sm"
        >
          <option value="">All groups</option>
          {allGroups.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>

        {allTags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => toggleTag(tag)}
                className={`px-2 py-0.5 rounded-full text-xs border transition-colors ${
                  tagFilter.includes(tag)
                    ? 'bg-zinc-800 dark:bg-zinc-200 text-white dark:text-zinc-900 border-zinc-800 dark:border-zinc-200'
                    : 'border-zinc-300 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-500'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-center py-12 text-zinc-400">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-zinc-400 space-y-2">
          <p className="text-base">
            {projects.length === 0
              ? 'No projects yet. Register one to start spawning sessions.'
              : 'No projects match the current filters.'}
          </p>
          {projects.length === 0 && (
            <Button variant="outline" onClick={() => setCreateOpen(true)}>
              Register Project
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Path</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Group</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((project) => (
                <TableRow key={project.id}>
                  <TableCell className="font-medium">{project.name}</TableCell>
                  <TableCell className="font-mono text-xs text-zinc-500 max-w-xs truncate">
                    {project.path}
                  </TableCell>
                  <TableCell>
                    <span className="px-1.5 py-0.5 rounded text-xs bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300">
                      {project.agentType}
                    </span>
                  </TableCell>
                  <TableCell className="text-zinc-500">{project.group ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1 flex-wrap">
                      {(project.tags ?? []).map((tag) => (
                        <span
                          key={tag}
                          className="px-1.5 py-0.5 rounded-full text-xs bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                        >
                          {tag}
                        </span>
                      ))}
                      {(!project.tags || project.tags.length === 0) && (
                        <span className="text-zinc-400">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-zinc-500 text-xs">
                    {new Date(project.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex gap-1 justify-end">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setEditProject(project)}
                      >
                        Edit
                      </Button>
                      <Button
                        size="xs"
                        variant="destructive"
                        onClick={() => setDeleteProject(project)}
                      >
                        Delete
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
