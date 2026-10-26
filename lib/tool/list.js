/**
 * ListWorkflowRuns: read the journal's run summaries, newest first — status,
 * counters, timestamps. Read-only over `listRuns` (DESIGN §3.6): no engine
 * coupling. The limit is capped by the caller-side parameter default; the
 * journal query enforces it.
 * @module dwf/tool/list
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { listRuns } from "../journal/projection.js";
export const LIST_WORKFLOW_RUNS_TOOL_NAME = 'list_workflow_runs';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** Build the ListWorkflowRuns tool over an opened journal database. */
export function listWorkflowRunsTool(db) {
    return defineTool({
        name: LIST_WORKFLOW_RUNS_TOOL_NAME,
        description: 'List recent workflow runs from the journal, newest first: id, name, status, node counters, and timestamps. Pair with get_workflow_run for one run\'s detail.',
        parameters: {
            limit: {
                type: 'number',
                description: `How many runs to return (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}).`,
            },
        },
        output: {
            // Run summaries are arbitrary lossless JSON.
            schema: { type: 'json' },
            render: (_args, value) => [{
                    type: 'text',
                    text: JSON.stringify(value, null, 2),
                }],
        },
        async execute(args) {
            const requested = args.limit;
            const limit = Math.min(Math.max(1, Math.floor(requested ?? DEFAULT_LIMIT)), MAX_LIMIT);
            return listRuns(db, limit);
        },
    });
}
