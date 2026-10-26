/** Tool-layer error codes (independent of the seam's WorkflowErrorCode). */

import { HarnessError } from '@deepseek-ai/dsh-llm'

export const DW_ERROR_CODES = {
  AMEND_UNAVAILABLE: 21,
  MISSING_BOUNDARIES: 22,
  SUBAGENT_MODEL: 23,
  SCRIPT_UNCHANGED: 24,
  SCRIPT_FILE: 25,
  SCRIPT_UNAVAILABLE: 26,
  RETUNE_UNCHANGED: 27,
  RUN_SETTLED: 28,
  NOT_RETUNABLE: 29,
  SAVED_UNAVAILABLE: 30,
  HOLE_UNAVAILABLE: 31,
} as const

export type DwfErrorCode = (typeof DW_ERROR_CODES)[keyof typeof DW_ERROR_CODES]

export class DwfError extends HarnessError {
  constructor(message: string, code: DwfErrorCode) {
    super(message, `DW_${code}`)
  }
}

export function amendUnavailable(tool: string): DwfError {
  return new DwfError(
    `${tool} is not implemented in dsh-dwf MVP: amend/resume cache is deferred. ` +
      'Re-run the workflow with the revised script instead (journal hooks input_hash/resumed_from are in place).',
    DW_ERROR_CODES.AMEND_UNAVAILABLE,
  )
}

export function savedUnavailable(tool: string): DwfError {
  return new DwfError(`${tool} is not implemented in dsh-dwf MVP: saved workflows are deferred (use inline scripts).`, DW_ERROR_CODES.SAVED_UNAVAILABLE)
}

export function holeUnavailable(holeId: string): DwfError {
  return new DwfError(`hole ${holeId} cannot be filled in dsh-dwf MVP: FillWorkflowHole is deferred; catch and proceed, or end the run.`, DW_ERROR_CODES.HOLE_UNAVAILABLE)
}
