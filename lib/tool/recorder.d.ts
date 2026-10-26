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
import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WorkflowRun, WorkflowRunId, WorkflowStopReason } from '@deepseek-ai/dsh-workflow';
/** Opens one durable top-level workflow run record. */
export interface DwfRunStartData {
    readonly runId: string;
    readonly name: string;
}
/** Records one workflow member after its child session is published. */
export interface DwfAgentStartData {
    readonly runId: string;
    readonly seq: number;
    readonly label: string;
    readonly phase?: string;
    readonly childId: string;
}
/** Settles one previously started workflow member. */
export interface DwfAgentEndData {
    readonly runId: string;
    readonly seq: number;
    readonly outcome: string;
}
/** Settles one workflow run after its live resources reach quiescence. */
export interface DwfRunEndData {
    readonly runId: string;
    readonly stopReason: string;
}
declare module '@deepseek-ai/dsh-session' {
    interface SessionEventMap {
        /** Opens one top-level workflow record. */
        'dwf/run-start': DwfRunStartData;
        /** Records one published workflow member. */
        'dwf/agent-start': DwfAgentStartData;
        /** Records one member settlement. */
        'dwf/agent-end': DwfAgentEndData;
        /** Closes one workflow record after cleanup. */
        'dwf/run-end': DwfRunEndData;
    }
}
/**
 * Project active top-level workflow runs into their parent Sessions without
 * letting recording failure affect tool execution. finish() carries the stop
 * reason (official finish(runId, stopReason) shape — the dwf/run-end payload
 * documents why the run ended, which a stopReason-less signature could not).
 */
export declare class RunRecorder {
    private readonly ctx;
    private readonly active;
    constructor(ctx: Context);
    /** Open the run's record; subsequent member events land in this session. */
    start(parentSession: Session, run: WorkflowRun): void;
    /** Close a settled run's record with its terminal reason. Idempotent per run. */
    finish(runId: WorkflowRunId, stopReason: WorkflowStopReason): void;
    /** Drop a run whose record must never open (or whose close already failed). */
    abandon(runId: WorkflowRunId): void;
    /**
     * Append one log-only record event. Returns false (and disables the run's
     * further recording) when the session rejects the append.
     */
    private append;
}
