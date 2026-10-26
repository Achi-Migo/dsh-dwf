/** Read-side projections over the journal (GetWorkflowRun / ListWorkflowRuns). */
import type { DatabaseSync } from 'node:sqlite';
export interface RunSummary {
    id: string;
    name: string;
    status: string;
    cwd?: string;
    timeCreated: number;
    timeUpdated: number;
    nodesTotal: number;
    nodesCompleted: number;
    nodesFailed: number;
}
export interface RunNodeView {
    siteId: string;
    ordinal: number;
    kind: string;
    status: string;
    actorSiteId?: string;
    artifactId?: string;
}
export interface RunView extends RunSummary {
    nodes: RunNodeView[];
    events: {
        sequence: number;
        type: string;
        timeCreated: number;
    }[];
    /** True when the node list is truncated for display at CAPS.maxNodes (DESIGN §3.4 展示帽 — ledger itself keeps every node). */
    nodesUnlisted?: boolean;
}
export declare function listRuns(db: DatabaseSync, limit: number): RunSummary[];
export declare function runProjection(db: DatabaseSync, runId: string): RunView | undefined;
