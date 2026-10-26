/**
 * The model-facing `workflow` tool: run a TypeScript-checked orchestration
 * script that fans out subagents, and return the script's final value. It owns
 * the model-facing schema and run lifecycle; script COMPILING, execution, caps
 * and cancellation live behind `ctx.workflowEngine` — this tool never compiles
 * (review B9: a single compilation path, engine.start; the `script` argument
 * is the user's source, passed through verbatim, and a synchronous
 * META_INVALID/SCRIPT_PARSE rejection surfaces as an isError result the model
 * can self-correct against). Foreground execution awaits `run.result` and
 * always disposes the run; non-completed reasons become tool errors.
 * `run_in_background: true` instead registers the run as an owned `ctx.jobs`
 * job and returns its id immediately — the job's output ring streams live
 * progress via the mirror, and the run's value arrives with the job's
 * completion notice.
 *
 * Forked from @deepseek-ai/dsh-tool-workflow/index.ts (v0.2.1-rc.3) with the
 * three mandatory replacements (dsh-contract.md §3.6): compile diagnostics
 * wired through engine.start only, the journal observation face, and the
 * DESCRIPTION/parameter contract rewritten for this plugin's facade
 * (description.ts — the official prompt-first agent() copy is banned here).
 * The official presentCall/presentResult cards are dropped: the stubbed
 * ToolDefinition face does not carry them (restored on a real dsh-tools).
 * @module dwf/tool/create
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DESCRIPTION, SCRIPT_PARAM_DESCRIPTION } from "./description.js";
import { RunRecorder } from "./recorder.js";
import { createWorkflowMirror } from "./mirror.js";
/** A non-`completed` stop reason means the script did not finish cleanly. */
function stopReasonError(result) {
    switch (result.stopReason) {
        case 'completed':
            return undefined;
        case 'cancelled':
            return `workflow run was cancelled${result.error !== undefined ? ` (${result.error})` : ''}`;
        case 'error':
            return `workflow run failed: ${result.error ?? 'unknown error'}`;
        /* defensive: WorkflowStopReason is a closed union, exhaustive by construction; a future variant fails here loudly */
        default:
            return `workflow run ended abnormally (${String(result.stopReason)})`;
    }
}
/** Render the run's outcome text: the meta name, agent count, and the JSON value (capped). */
function renderResult(name, agentsStarted, value, maxChars) {
    // The engine returns JSON data (null for a valueless script), so stringify never yields undefined.
    const rendered = JSON.stringify(value, null, 2);
    const clipped = rendered.length > maxChars
        ? `${rendered.slice(0, maxChars)}\n… [truncated: ${rendered.length - maxChars} more characters]`
        : rendered;
    return `workflow "${name}" completed (${agentsStarted} agent${agentsStarted === 1 ? '' : 's'}).\nReturn value:\n${clipped}`;
}
/**
 * Map a settled background run onto the job outcome vocabulary. A completed
 * run carries the rendered return value as the job's result; a cancelled run
 * leaves the detail to the registry's kill-reason merge; an errored run fails
 * with the script's failure message.
 */
function jobOutcomeOf(result, name, maxChars) {
    switch (result.stopReason) {
        case 'completed':
            return {
                status: 'completed',
                detail: `${result.agentsStarted} agent${result.agentsStarted === 1 ? '' : 's'}`,
                result: renderResult(name, result.agentsStarted, result.value, maxChars),
            };
        case 'cancelled':
            return { status: 'killed' };
        case 'error':
            return { status: 'failed', detail: result.error ?? 'unknown error' };
        /* defensive: WorkflowStopReason is a closed union, exhaustive by construction; a future variant fails here loudly */
        default:
            return { status: 'failed', detail: `workflow run ended abnormally (${String(result.stopReason)})` };
    }
}
/**
 * Register a background run as an owned job. The engine run is started inside
 * the job starter with no tool-step signal — the run belongs to the job, so a
 * registry kill or owner teardown is what cancels it — and its settlement is
 * the job's settlement: dispose, stop the mirror, then map the stop reason
 * onto the job outcome.
 */
function startBackgroundRun(ctx, args, parent, toolCall, recordsRun, deps) {
    const jobs = ctx.get('jobs');
    if (jobs === null || jobs === undefined) {
        throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and a jobs registry implementation');
    }
    let run;
    const jobId = jobs.start({
        kind: 'workflow',
        label: args.meta.name,
        owner: parent.id,
        toolCall,
        run: (job) => {
            // A synchronous engine rejection (META_INVALID/SCRIPT_PARSE) propagates
            // out of the starter, so the registry registers nothing and the model
            // sees the violation list as an ordinary tool error.
            run = ctx.workflowEngine.start({
                script: args.script,
                meta: args.meta,
                ...(args.args !== undefined ? { args: args.args } : {}),
                parent,
            });
            deps.mirror.start(run.id, job);
            if (recordsRun)
                deps.recorder.start(parent.session, run);
            const done = run.result.then(async (result) => {
                try {
                    // Keep member listeners alive through disposal: an engine may
                    // synthesize cancelled member endings while reaching quiescence.
                    await run.dispose();
                }
                catch (error) {
                    // done must not reject; a failed disposal still has a settled result to report.
                    ctx.logger.warn(`background workflow run ${run.id} dispose failed: ${String(error)}`);
                }
                deps.mirror.stop(run.id);
                if (recordsRun) {
                    deps.recorder.finish(run.id, result.stopReason);
                    deps.recorder.abandon(run.id);
                }
                return jobOutcomeOf(result, args.meta.name, deps.maxResultChars);
            });
            return {
                cancel: (reason) => { run.cancel(reason ?? 'background workflow job killed'); },
                done,
            };
        },
    });
    return { kind: 'background', jobId, runId: run.id };
}
/**
 * Build the CreateWorkflow tool definition (DESIGN §3.6). The caller (the
 * plugin apply) registers it under config.toolName; compilation happens
 * exclusively inside engine.start.
 */
export function createWorkflowTool(ctx, config) {
    const recorder = new RunRecorder(ctx);
    const mirror = createWorkflowMirror(ctx);
    return defineTool({
        name: config.toolName,
        description: DESCRIPTION,
        parameters: {
            script: {
                type: 'string',
                required: true,
                description: SCRIPT_PARAM_DESCRIPTION,
            },
            meta: {
                type: 'object',
                additionalProperties: true,
                required: true,
                description: 'The workflow identity as plain JSON, not code.',
                properties: {
                    name: { type: 'string', required: true, description: 'Short kebab-case workflow name.' },
                    description: { type: 'string', required: true, description: 'One-line description of what the workflow does.' },
                    whenToUse: { type: 'string', description: 'Optional guidance on when this workflow applies.' },
                    phases: {
                        type: 'array',
                        description: 'Optional phase declarations matched by phase() calls.',
                        items: {
                            type: 'object',
                            additionalProperties: true,
                            properties: {
                                title: { type: 'string', required: true, description: 'The phase title phase() calls match by exact string.' },
                                detail: { type: 'string', description: 'Optional one-line description of the phase.' },
                                provider: { type: 'string', description: 'Optional provider override this phase is expected to use.' },
                                model: { type: 'string', description: 'Optional model override this phase is expected to use.' },
                            },
                        },
                    },
                },
            },
            args: {
                type: 'object',
                additionalProperties: true,
                description: 'Optional JSON input exposed to the script as the `args` global (wrap a bare list as a field, e.g. {"files": [...]}).',
            },
            ...(config.enableRunInBackground ? {
                run_in_background: {
                    type: 'boolean',
                    description: 'Run as a background job: return a job id immediately instead of waiting; the return value arrives with the completion notice.',
                },
            } : {}),
        },
        output: {
            schema: {
                oneOf: [
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'background' },
                            jobId: { type: 'string', required: true },
                            runId: { type: 'string', required: true },
                        },
                    },
                    {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            kind: { type: 'string', required: true, const: 'foreground' },
                            runId: { type: 'string', required: true },
                            agentsStarted: { type: 'integer', required: true },
                            result: { type: 'json', required: true },
                        },
                    },
                ],
            },
            render: (args, value) => {
                const callArgs = args;
                const outcome = value;
                return [{
                        type: 'text',
                        text: outcome.kind === 'background'
                            ? `workflow "${callArgs.meta.name}" started in the background as job ${outcome.jobId}. Its return value arrives with the completion notice; check on it with job_output, stop it with job_kill.`
                            : renderResult(callArgs.meta.name, outcome.agentsStarted, outcome.result, config.maxResultChars),
                    }];
            },
        },
        async execute(args, exec) {
            const callArgs = args;
            const parent = exec.agent;
            if (!parent) {
                // The loop sets `exec.agent` for every model-driven call; its absence
                // means a non-agent caller invoked the tool directly, which has no
                // parent to attribute the children to. Fail loud rather than guess.
                throw new Error('workflow tool requires a calling agent (exec.agent was undefined)');
            }
            if (callArgs.run_in_background === true) {
                if (!config.enableRunInBackground) {
                    throw new Error('run_in_background is disabled for this tool');
                }
                return startBackgroundRun(ctx, callArgs, parent, { callId: exec.callId, rootCallId: exec.rootCallId }, exec.parent === undefined, { recorder, mirror, maxResultChars: config.maxResultChars });
            }
            // Meta/body validation failures (META_INVALID/SCRIPT_PARSE) throw
            // synchronously here and become isError results via the registry — the
            // model sees the violation list and can correct the call. This is the
            // plugin's ONLY compilation path (review B9): the script is forwarded
            // as the user wrote it.
            const run = ctx.workflowEngine.start({
                script: callArgs.script,
                meta: callArgs.meta,
                ...(callArgs.args !== undefined ? { args: callArgs.args } : {}),
                parent,
                signal: exec.signal,
            });
            const recordsRun = exec.parent === undefined;
            // The engine publishes member events after start() returns and this run record is active.
            if (recordsRun)
                recorder.start(parent.session, run);
            // Bridge the tool's abort signal to the run: if the parent step is aborted while the
            // script is in flight, cancel the whole run. The signal also enters the engine directly, but
            // this local bridge preserves the tool contract even if an implementation ignores it.
            const onAbort = () => { run.cancel('parent step aborted'); };
            exec.signal.addEventListener('abort', onAbort, { once: true });
            let result;
            try {
                result = await run.result;
                const error = stopReasonError(result);
                if (error !== undefined) {
                    // Map a non-clean finish to an isError result (the registry turns a
                    // throw into an isError). Report the reason, not partial output.
                    throw new Error(error);
                }
                const outcome = {
                    kind: 'foreground',
                    runId: run.id,
                    agentsStarted: result.agentsStarted,
                    // The seam types the script value `unknown`; the tool's output
                    // contract (oneOf → result: json) narrows it to lossless JSON, which
                    // engine materialization guarantees (realm-side JSON-only checks).
                    result: result.value,
                };
                return outcome;
            }
            finally {
                exec.signal.removeEventListener('abort', onAbort);
                try {
                    // Keep member listeners alive through disposal: an engine may
                    // synthesize cancelled member endings while reaching quiescence.
                    await run.dispose();
                    if (recordsRun) {
                        // WorkflowRun.result never rejects by contract, so result is assigned before finally.
                        if (result === undefined)
                            throw new Error('workflow run settled without a result');
                        recorder.finish(run.id, result.stopReason);
                    }
                }
                finally {
                    if (recordsRun)
                        recorder.abandon(run.id);
                }
            }
        },
    });
}
