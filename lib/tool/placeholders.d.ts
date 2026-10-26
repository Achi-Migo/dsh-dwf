/**
 * Placeholder tools for the deferred capability families (mechanism-map §1/§11,
 * DESIGN §3.6/§6.2). The shells exist so the model gets a precise, routable
 * error instead of a silent missing-tool: the amend/resume family (including
 * hole-filling and question resolution, which ride the amend-resume cache)
 * answers AMEND_UNAVAILABLE (21); the saved-workflow family answers
 * SAVED_UNAVAILABLE (30). Errors come from the util/errors.ts factories and
 * reach the model as isError results via the registry.
 * @module dwf/tool/placeholders
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
/** AmendWorkflow: revise a settled run's script and reuse cached work — deferred. */
export declare function amendWorkflowTool(): ToolDefinition;
/** ResumeWorkflowRun: replay a run's journal instead of rerunning it — deferred. */
export declare function resumeWorkflowRunTool(): ToolDefinition;
/** FillWorkflowHole: answer a parked hole at run time — deferred (unfilled holes fail fast with HOLE_UNAVAILABLE instead of parking). */
export declare function fillWorkflowHoleTool(): ToolDefinition;
/** ResolveWorkflowQuestion: answer an escalated subagent question — deferred with the escalation bridge. */
export declare function resolveWorkflowQuestionTool(): ToolDefinition;
/** SaveWorkflow: persist a script with declared arguments for reuse — deferred. */
export declare function saveWorkflowTool(): ToolDefinition;
/** ListSavedWorkflows: enumerate saved workflow scripts — deferred with SaveWorkflow. */
export declare function listSavedWorkflowsTool(): ToolDefinition;
/** The six placeholder tools, in registration order. */
export declare function placeholderTools(): ToolDefinition[];
