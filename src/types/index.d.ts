/**
 * dsh-dwf public vocabulary: caps, journal event names, and the tool error codes.
 * @module @local/dsh-dwf/types
 */

export type { DwfErrorCode } from '../util/errors.js'

/** Facade caps (facade.d.ts annotations + reverse-engineered constants). */
export interface Caps {
  maxPhases: number
  maxPhaseNameLength: number
  maxSubagents: number
  maxNodes: number
  worldStdoutCap: number
  worldReadCap: number
  grepResultBytes: number
  gitDiffBytes: number
  gitLogCommits: number
  reportItemsPerRun: number
  reportItemBytes: number
  reportTotalBytes: number
  artifactIds: number
  artifactVersions: number
  artifactFileBytes: number
  artifactMdBytes: number
  artifactTitleChars: number
  artifactDescriptionChars: number
}

export type JournalEventName =
  | 'run-started'
  | 'run-launched'
  | 'run-settled'
  | 'actor-created'
  | 'node-queued'
  | 'node-dispatched'
  | 'node-executing'
  | 'node-waiting'
  | 'node-settled'
  | 'log'
  | 'report'
  | 'phase-entered'
  | 'artifact-published'
  | 'artifact-failed'
  | 'model-failover'
