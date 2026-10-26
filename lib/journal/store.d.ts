/**
 * Append-only journal store. Single-writer in-process: per-run event sequences
 * and per-site ordinals are assigned here monotonically (review B11) with a
 * MAX+1 recovery for a reopened database.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { Json } from '../util/json.ts';
import type { JournalEventName } from '../types/index.d.ts';
export interface RunRow {
    id: string;
    parentSessionId?: string;
    cwd?: string;
    name: string;
    script: string;
    args?: unknown;
    capsMaxConcurrency?: number;
}
export type NodeKind = 'ask' | 'world-read' | 'world-run' | 'report' | 'artifact';
export interface NodeRecord {
    siteId: string;
    kind: NodeKind;
    input: Json;
    status: 'running' | 'completed' | 'failed';
    result?: Json;
    error?: string;
    actorSiteId?: string;
    actorOrdinal?: number;
    actorSeq?: number;
    artifactId?: string;
}
export interface JournalEvent {
    type: JournalEventName;
    payload?: Json;
}
export interface RunOutcome {
    status: 'completed' | 'failed' | 'cancelled';
    result?: Json;
    failure?: string;
    spentTokens?: number;
}
/**
 * Run-scoped write face (DESIGN §3.4): writerFor(runId) hands out one writer
 * per run; the recordActor member is part of the interface proper (拍板表#17 —
 * store 兼办 dwf_actor 落行，接口面与文档一次对齐). Counters are dropped when
 * the run settles (拍板表#10), so nothing lingers across runs.
 */
export interface RunWriter {
    beginRun(run: RunRow): void;
    appendEvent(event: JournalEvent): void;
    recordNode(node: NodeRecord): {
        siteId: string;
        ordinal: number;
    };
    recordActor(siteId: string, ordinal: number, name: string | undefined, persona: Json | undefined, sessionId?: string): void;
    settleRun(outcome: RunOutcome): void;
}
export declare class JournalStore {
    private readonly db;
    private readonly sequences;
    private readonly ordinals;
    constructor(db: DatabaseSync);
    /** 每 run 一个写手：方法绑定到该 run 的 id，结算时计数器随之回收。 */
    writerFor(runId: string): RunWriter;
    private nextSequence;
    private maxSequence;
    private nextOrdinal;
    private maxOrdinal;
    static inputHash(input: Json): string;
    beginRun(run: RunRow): void;
    appendEvent(runId: string, event: JournalEvent): void;
    recordNode(runId: string, node: NodeRecord): {
        siteId: string;
        ordinal: number;
    };
    recordActor(runId: string, siteId: string, ordinal: number, name: string | undefined, persona: Json | undefined, sessionId?: string): void;
    settleRun(runId: string, outcome: RunOutcome): void;
}
