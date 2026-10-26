/**
 * Live-progress mirror for background workflow runs: streams the engine's
 * `workflow/phase`, `workflow/log`, and member lifecycle events into the
 * owning job's output ring as log lines — observer-only narration the model's
 * job output never renders — and keeps the job's live progress line on the
 * current phase.
 *
 * Forked from @deepseek-ai/dsh-tool-workflow/record.ts (v0.2.1-rc.3, whole
 * file). One deviation from the official text: appends go through the stubbed
 * JobHandle face `append(line)`; the official `{ channel: 'log' }` options
 * argument belongs to the unmirrored jobs runtime and is restored when this
 * compiles against the real `@deepseek-ai/dsh-jobs`. DESIGN §3.6 sketched a
 * `mirrorToJob(run, job)` signature, but streaming `workflow/*` events needs
 * the ctx event bus, which a (run, job) pair does not carry — the official
 * create-mirror factory shape is the contract here.
 * @module dwf/tool/mirror
 */
import type { Context } from '@deepseek-ai/cordis';
import type { JobHandle } from '@deepseek-ai/dsh-jobs';
import type { WorkflowRunId } from '@deepseek-ai/dsh-workflow';
/** Job-ring taps for the background runs the tool tracks. */
export interface WorkflowMirror {
    /**
     * Route a run's progress events into a job's ring. Call once per background
     * run, from the job starter, before the worker publishes its first event.
     * @param runId - the started run.
     * @param job - the owning job's producer face.
     */
    start(runId: WorkflowRunId, job: JobHandle): void;
    /**
     * Stop routing a settled or abandoned run. Idempotent.
     * @param runId - the run to drop.
     */
    stop(runId: WorkflowRunId): void;
}
/**
 * Create the run-to-ring mirror and subscribe the engine's live progress
 * events for the runs it tracks.
 * @param ctx - plugin context whose event bus carries the `workflow/*` events.
 * @returns the mirror taps the tool wires around each background run.
 */
export declare function createWorkflowMirror(ctx: Context): WorkflowMirror;
