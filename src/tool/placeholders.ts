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

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { amendUnavailable, savedUnavailable } from '../util/errors.ts'

function placeholderTool(name: string, description: string, fail: () => Error): ToolDefinition {
  return defineTool({
    name,
    description,
    parameters: {},
    output: {
      // These tools always throw; the schema is a formal never-produced value.
      schema: { type: 'null' },
      render: () => [],
    },
    async execute() {
      // The registry maps the thrown DwfError onto an isError result carrying
      // its machine-routable DW_* code.
      throw fail()
    },
  })
}

/** AmendWorkflow: revise a settled run's script and reuse cached work — deferred. */
export function amendWorkflowTool(): ToolDefinition {
  return placeholderTool(
    'amend_workflow',
    'Revise a settled workflow script and rerun it, reusing unchanged work from the run being amended (matched by named agents and identical ask instructions). NOT available in this release.',
    () => amendUnavailable('AmendWorkflow'),
  )
}

/** ResumeWorkflowRun: replay a run's journal instead of rerunning it — deferred. */
export function resumeWorkflowRunTool(): ToolDefinition {
  return placeholderTool(
    'resume_workflow_run',
    'Resume a settled workflow run by replaying its journal: recorded asks, world reads and reports settle from the record instead of executing again. NOT available in this release.',
    () => amendUnavailable('ResumeWorkflowRun'),
  )
}

/** FillWorkflowHole: answer a parked hole at run time — deferred (unfilled holes fail fast with HOLE_UNAVAILABLE instead of parking). */
export function fillWorkflowHoleTool(): ToolDefinition {
  return placeholderTool(
    'fill_workflow_hole',
    'Fill a workflow hole at run time with a body the run executes in its place. NOT available in this release: an unfilled hole fails the run deterministically (HOLE_UNAVAILABLE) rather than waiting.',
    () => amendUnavailable('FillWorkflowHole'),
  )
}

/** ResolveWorkflowQuestion: answer an escalated subagent question — deferred with the escalation bridge. */
export function resolveWorkflowQuestionTool(): ToolDefinition {
  return placeholderTool(
    'resolve_workflow_question',
    'Answer a question a workflow subagent escalated to the user; the answer becomes the subagent\'s return value. NOT available in this release: subagents answer on their own instead of escalating.',
    () => amendUnavailable('ResolveWorkflowQuestion'),
  )
}

/** SaveWorkflow: persist a script with declared arguments for reuse — deferred. */
export function saveWorkflowTool(): ToolDefinition {
  return placeholderTool(
    'save_workflow',
    'Save a workflow script (with declared arguments and usage metadata) for reuse without pasting it again. NOT available in this release: run scripts inline.',
    () => savedUnavailable('SaveWorkflow'),
  )
}

/** ListSavedWorkflows: enumerate saved workflow scripts — deferred with SaveWorkflow. */
export function listSavedWorkflowsTool(): ToolDefinition {
  return placeholderTool(
    'list_saved_workflows',
    'List saved workflow scripts with their names, descriptions, and declared arguments. NOT available in this release: no workflows can be saved yet.',
    () => savedUnavailable('ListSavedWorkflows'),
  )
}

/** The six placeholder tools, in registration order. */
export function placeholderTools(): ToolDefinition[] {
  return [
    amendWorkflowTool(),
    resumeWorkflowRunTool(),
    fillWorkflowHoleTool(),
    resolveWorkflowQuestionTool(),
    saveWorkflowTool(),
    listSavedWorkflowsTool(),
  ]
}
