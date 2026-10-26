/** Read-side projections over the journal (GetWorkflowRun / ListWorkflowRuns). */

import type { DatabaseSync } from 'node:sqlite'

import { CAPS } from './caps.ts'

export interface RunSummary {
  id: string
  name: string
  status: string
  cwd?: string
  timeCreated: number
  timeUpdated: number
  nodesTotal: number
  nodesCompleted: number
  nodesFailed: number
}

export interface RunNodeView {
  siteId: string
  ordinal: number
  kind: string
  status: string
  actorSiteId?: string
  artifactId?: string
}

export interface RunView extends RunSummary {
  nodes: RunNodeView[]
  events: { sequence: number; type: string; timeCreated: number }[]
  /** True when the node list is truncated for display at CAPS.maxNodes (DESIGN §3.4 展示帽 — ledger itself keeps every node). */
  nodesUnlisted?: boolean
}

function mapSummary(row: Record<string, unknown>): RunSummary {
  return {
    id: row.id as string,
    name: row.name as string,
    status: row.status as string,
    cwd: row.cwd === null ? undefined : (row.cwd as string),
    timeCreated: row.time_created as number,
    timeUpdated: row.time_updated as number,
    nodesTotal: row.nodes_total as number,
    nodesCompleted: row.nodes_completed as number,
    nodesFailed: row.nodes_failed as number,
  }
}

export function listRuns(db: DatabaseSync, limit: number): RunSummary[] {
  const rows = db
    .prepare(
      `select r.*, 
         (select count(*) from dwf_node n where n.run_id = r.id) as nodes_total,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'completed') as nodes_completed,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'failed') as nodes_failed
       from dwf_run r order by r.time_created desc limit ?`,
    )
    .all(limit) as unknown as Record<string, unknown>[]
  return rows.map(mapSummary)
}

export function runProjection(db: DatabaseSync, runId: string): RunView | undefined {
  const row = db
    .prepare(
      `select r.*,
         (select count(*) from dwf_node n where n.run_id = r.id) as nodes_total,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'completed') as nodes_completed,
         (select count(*) from dwf_node n where n.run_id = r.id and n.status = 'failed') as nodes_failed
       from dwf_run r where r.id = ?`,
    )
    .get(runId) as Record<string, unknown> | undefined
  if (row === undefined) return undefined
  // 展示帽探测（DESIGN §3.4）：多取一条判断是否超帽；超帽截到 maxNodes 并置 nodesUnlisted，
  // 记账不阻断——dwf_node 里的事实完整保留，仅投影列表截断。
  const nodeRows = db
    .prepare(
      'select site_id, ordinal, kind, status, actor_site_id, artifact_id from dwf_node where run_id = ? order by id limit ?',
    )
    .all(runId, CAPS.maxNodes + 1) as unknown as Record<string, unknown>[]
  const nodesUnlisted = nodeRows.length > CAPS.maxNodes ? true : undefined
  const nodes = nodeRows
    .slice(0, CAPS.maxNodes)
    .map((n) => ({
    siteId: n.site_id as string,
    ordinal: n.ordinal as number,
    kind: n.kind as string,
    status: n.status as string,
    actorSiteId: n.actor_site_id === null ? undefined : (n.actor_site_id as string),
    artifactId: n.artifact_id === null ? undefined : (n.artifact_id as string),
  }))
  const events = (
    db.prepare('select sequence, type, time_created from dwf_event where run_id = ? order by sequence').all(runId) as unknown as Record<string, unknown>[]
  ).map((e) => ({ sequence: e.sequence as number, type: e.type as string, timeCreated: e.time_created as number }))
  return { ...mapSummary(row), nodes, events, nodesUnlisted }
}
