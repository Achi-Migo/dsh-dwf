/**
 * GetWorkflowRun: read one run's projection out of the journal — nodes, events,
 * counters, status. Read-only over `runProjection` (DESIGN §3.6): no engine
 * coupling, no live-run access, a settled or running row reads the same way.
 * Unknown ids are a tool error (the registry turns the throw into isError).
 * @module dwf/tool/get
 */
import type { DatabaseSync } from 'node:sqlite';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
export declare const GET_WORKFLOW_RUN_TOOL_NAME = "get_workflow_run";
/** Build the GetWorkflowRun tool over an opened journal database. */
export declare function getWorkflowRunTool(db: DatabaseSync): ToolDefinition;
