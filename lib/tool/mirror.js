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
/**
 * Create the run-to-ring mirror and subscribe the engine's live progress
 * events for the runs it tracks.
 * @param ctx - plugin context whose event bus carries the `workflow/*` events.
 * @returns the mirror taps the tool wires around each background run.
 */
export function createWorkflowMirror(ctx) {
    const active = new Map();
    ctx.on('workflow/phase', (info, title) => {
        const job = active.get(info.id);
        if (job === undefined)
            return;
        job.updateProgress(title);
        job.append(`▸ ${title}\n`);
    });
    ctx.on('workflow/log', (info, message) => {
        active.get(info.id)?.append(`${message}\n`);
    });
    ctx.on('workflow/agent-start', (info, agent) => {
        active.get(info.id)?.append(`agent #${agent.seq} ${agent.label} started\n`);
    });
    ctx.on('workflow/agent-end', (info, agent) => {
        active.get(info.id)?.append(`agent #${agent.seq} ${agent.outcome}\n`);
    });
    return {
        start(runId, job) {
            active.set(runId, job);
        },
        stop(runId) {
            active.delete(runId);
        },
    };
}
