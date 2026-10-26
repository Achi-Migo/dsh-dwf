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
/** Render a contained recording failure without trusting the thrown value. */
function renderRecordingError(error) {
    try {
        return String(error);
    }
    catch {
        return '[unrenderable thrown value]';
    }
}
/**
 * Project active top-level workflow runs into their parent Sessions without
 * letting recording failure affect tool execution. finish() carries the stop
 * reason (official finish(runId, stopReason) shape — the dwf/run-end payload
 * documents why the run ended, which a stopReason-less signature could not).
 */
export class RunRecorder {
    ctx;
    active = new Map();
    constructor(ctx) {
        this.ctx = ctx;
        ctx.on('workflow/agent-start', (info, agent) => {
            const session = this.active.get(info.id);
            if (session === undefined)
                return;
            const data = {
                runId: info.id,
                seq: agent.seq,
                label: agent.label,
                ...(agent.phase === undefined ? {} : { phase: agent.phase }),
                childId: agent.childId,
            };
            if (!this.append(session, 'dwf/agent-start', data))
                this.active.delete(info.id);
        });
        ctx.on('workflow/agent-end', (info, agent) => {
            const session = this.active.get(info.id);
            if (session === undefined)
                return;
            const data = {
                runId: info.id,
                seq: agent.seq,
                outcome: agent.outcome,
            };
            if (!this.append(session, 'dwf/agent-end', data))
                this.active.delete(info.id);
        });
    }
    /** Open the run's record; subsequent member events land in this session. */
    start(parentSession, run) {
        if (this.append(parentSession, 'dwf/run-start', { runId: run.id, name: run.meta.name })) {
            this.active.set(run.id, parentSession);
        }
    }
    /** Close a settled run's record with its terminal reason. Idempotent per run. */
    finish(runId, stopReason) {
        const session = this.active.get(runId);
        if (session !== undefined)
            this.append(session, 'dwf/run-end', { runId, stopReason });
        this.active.delete(runId);
    }
    /** Drop a run whose record must never open (or whose close already failed). */
    abandon(runId) {
        this.active.delete(runId);
    }
    /**
     * Append one log-only record event. Returns false (and disables the run's
     * further recording) when the session rejects the append.
     */
    append(session, type, data) {
        try {
            session.append(type, data);
            return true;
        }
        catch (error) {
            this.ctx.logger.warn(`dwf: disabled durable record after ${type} append failed: ${renderRecordingError(error)}`);
            return false;
        }
    }
}
