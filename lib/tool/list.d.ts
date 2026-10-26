/**
 * ListWorkflowRuns: read the journal's run summaries, newest first — status,
 * counters, timestamps. Read-only over `listRuns` (DESIGN §3.6): no engine
 * coupling. The limit is capped by the caller-side parameter default; the
 * journal query enforces it.
 * @module dwf/tool/list
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const LIST_WORKFLOW_RUNS_TOOL_NAME = "list_workflow_runs";
/** Build the ListWorkflowRuns tool over an opened journal database. */
export declare function listWorkflowRunsTool(db: DatabaseSync): ToolDefinition;
