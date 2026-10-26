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
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        workflow: unknown;
    }
}
/** Tool-facing slice of the plugin Config (DESIGN §1.3). */
export interface WorkflowToolConfig {
    /** The model-facing tool name to register (default `workflow`). */
    toolName: string;
    /** Rendered-result ceiling, in characters: a longer JSON value is truncated with a notice. */
    maxResultChars: number;
    /** Expose `run_in_background`; disabled calls are also rejected (official gating). */
    enableRunInBackground: boolean;
}
/**
 * Build the CreateWorkflow tool definition (DESIGN §3.6). The caller (the
 * plugin apply) registers it under config.toolName; compilation happens
 * exclusively inside engine.start.
 */
export declare function createWorkflowTool(ctx: Context, config: WorkflowToolConfig): ToolDefinition;
