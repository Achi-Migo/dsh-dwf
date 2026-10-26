/**
 * GetWorkflowRun: read one run's projection out of the journal — nodes, events,
 * counters, status. Read-only over `runProjection` (DESIGN §3.6): no engine
 * coupling, no live-run access, a settled or running row reads the same way.
 * Unknown ids are a tool error (the registry turns the throw into isError).
 * @module dwf/tool/get
 */

import type { DatabaseSync } from 'node:sqlite'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { runProjection } from '../journal/projection.ts'

export const GET_WORKFLOW_RUN_TOOL_NAME = 'get_workflow_run'

/** Build the GetWorkflowRun tool over an opened journal database. */
export function getWorkflowRunTool(db: DatabaseSync): ToolDefinition {
  return defineTool({
    name: GET_WORKFLOW_RUN_TOOL_NAME,
    description: 'Read one workflow run from the journal: status, node ledger (ask/world/report/artifact sites), event log, and counters. Works for running and settled runs alike.',
    parameters: {
      runId: {
        type: 'string',
        required: true,
        description: 'The workflow run id, as returned by the create tool (the `runId` field).',
      },
    },
    output: {
      // The run projection is arbitrary lossless JSON.
      schema: { type: 'json' as const },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value, null, 2),
      }],
    },
    async execute(args) {
      const { runId } = args as { runId: string }
      const view = runProjection(db, runId)
      if (view === undefined) {
        throw new Error(`workflow run not found: ${runId}`)
      }
      return view as unknown as JsonValue
    },
  })
}
