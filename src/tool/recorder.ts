/**
 * Session observation face for workflow runs: projects the engine's
 * `workflow/agent-start` / `workflow/agent-end` member events (plus the run
 * open/close) into the parent Session's durable `dwf/*` log events.
 *
 * Forked from @deepseek-ai/dsh-tool-workflow (index.ts:93-151 + types.ts
 * whole file, v0.2.1-rc.3). Two deliberate differences from the official
 * module:
 *  1. the recorder is a class (DESIGN §3.6) instead of a closure factory —
 *     same behavior, the constructor carries the ctx subscriptions;
 *  2. the `SessionEventMap` declare-module augmentation for the `dwf/*`
 *     events lives HERE and only here. The ambient stub previously
 *     pre-placed the same members; that pre-placement was removed (review
 *     gap-audit §3.13 ➕: a double declaration is where two copies start to
 *     drift — this file is the single source of the dwf/* vocabulary).
 *
 * Any append failure permanently disables that run's further recording — the
 * log can then only be a legal prefix — and a recording failure never affects
 * tool execution.
 * @module dwf/tool/recorder
 */

import type { Context } from '@deepseek-ai/cordis'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'
import type { Session, SessionEventMap } from '@deepseek-ai/dsh-session'
import type {
  WorkflowAgentEndInfo,
  WorkflowAgentInfo,
  WorkflowRun,
  WorkflowRunId,
  WorkflowStopReason,
} from '@deepseek-ai/dsh-workflow'

/** Opens one durable top-level workflow run record. */
export interface DwfRunStartData {
  readonly runId: string
  readonly name: string
}

/** Records one workflow member after its child session is published. */
export interface DwfAgentStartData {
  readonly runId: string
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId: string
}

/** Settles one previously started workflow member. */
export interface DwfAgentEndData {
  readonly runId: string
  readonly seq: number
  readonly outcome: string
}

/** Settles one workflow run after its live resources reach quiescence. */
export interface DwfRunEndData {
  readonly runId: string
  readonly stopReason: string
}

/** The four log-only events this recorder appends to the parent session. */
type DwfRecordEvent = 'dwf/run-start' | 'dwf/agent-start' | 'dwf/agent-end' | 'dwf/run-end'

// Type augmentation alone does not register durable events at runtime. The
// persistence reader rejects an entire session when it encounters an unknown,
// non-ignorable event. Register at module load (before history is observed),
// not in RunRecorder's constructor, which only runs for new workflows.
// These four records are observations only; unknown unrelated types stay denied.
for (const type of [
  'dwf/run-start', 'dwf/agent-start', 'dwf/agent-end', 'dwf/run-end',
] satisfies DwfRecordEvent[]) {
  // The host exposes a ReadonlySet type, but currently stores a mutable Set;
  // replace this compatibility bridge when it provides a registration API.
  ;(KNOWN_SESSION_EVENT_TYPES as Set<string>).add(type)
}

declare module '@deepseek-ai/dsh-session' {
  interface SessionEventMap {
    /** Opens one top-level workflow record. */
    'dwf/run-start': DwfRunStartData
    /** Records one published workflow member. */
    'dwf/agent-start': DwfAgentStartData
    /** Records one member settlement. */
    'dwf/agent-end': DwfAgentEndData
    /** Closes one workflow record after cleanup. */
    'dwf/run-end': DwfRunEndData
  }
}

/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/** Minimal snapshot of the run-info face the two member events carry. */
interface RunEventInfo {
  readonly id: WorkflowRunId
}

/**
 * Project active top-level workflow runs into their parent Sessions without
 * letting recording failure affect tool execution. finish() carries the stop
 * reason (official finish(runId, stopReason) shape — the dwf/run-end payload
 * documents why the run ended, which a stopReason-less signature could not).
 */
export class RunRecorder {
  private readonly ctx: Context
  private readonly active = new Map<WorkflowRunId, Session>()

  constructor(ctx: Context) {
    this.ctx = ctx
    ctx.on('workflow/agent-start', (info: RunEventInfo, agent: WorkflowAgentInfo) => {
      const session = this.active.get(info.id)
      if (session === undefined) return
      const data: DwfAgentStartData = {
        runId: info.id,
        seq: agent.seq,
        label: agent.label,
        ...(agent.phase === undefined ? {} : { phase: agent.phase }),
        childId: agent.childId,
      }
      if (!this.append(session, 'dwf/agent-start', data)) this.active.delete(info.id)
    })
    ctx.on('workflow/agent-end', (info: RunEventInfo, agent: WorkflowAgentEndInfo) => {
      const session = this.active.get(info.id)
      if (session === undefined) return
      const data: DwfAgentEndData = {
        runId: info.id,
        seq: agent.seq,
        outcome: agent.outcome,
      }
      if (!this.append(session, 'dwf/agent-end', data)) this.active.delete(info.id)
    })
  }

  /** Open the run's record; subsequent member events land in this session. */
  start(parentSession: Session, run: WorkflowRun): void {
    if (this.append(parentSession, 'dwf/run-start', { runId: run.id, name: run.meta.name })) {
      this.active.set(run.id, parentSession)
    }
  }

  /** Close a settled run's record with its terminal reason. Idempotent per run. */
  finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void {
    const session = this.active.get(runId)
    if (session !== undefined) this.append(session, 'dwf/run-end', { runId, stopReason })
    this.active.delete(runId)
  }

  /** Drop a run whose record must never open (or whose close already failed). */
  abandon(runId: WorkflowRunId): void {
    this.active.delete(runId)
  }

  /**
   * Append one log-only record event. Returns false (and disables the run's
   * further recording) when the session rejects the append.
   */
  private append<Type extends DwfRecordEvent>(
    session: Session,
    type: Type,
    data: SessionEventMap[Type],
  ): boolean {
    try {
      // Real Session.append carries a conditional surface-opts rest parameter
      // (`...opts: T extends SurfaceEventType ? [opts] : []`); dwf/* events are
      // log-only (never SurfaceEventType), so the tuple is always empty. The
      // cast states that invariant instead of weakening every call site.
      type LogOnlyAppend = <T extends DwfRecordEvent>(t: T, d: SessionEventMap[T]) => unknown
      ;(session.append as LogOnlyAppend)(type, data)
      return true
    } catch (error: unknown) {
      this.ctx.logger.warn(`dwf: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`)
      return false
    }
  }
}
