/**
 * Guest↔host protocol: the four bindings of the original stdio NDJSON design,
 * mapped onto PTC binding functions (design §3.3):
 *   begin()               → the run's WorkerInit (meta/args/limits)          [request]
 *   request(req)          → ask | world-read | world-run | hole | report |
 *                           publish-artifact; response resolves or rejects    [request]
 *   event(evt)            → log | phase-entered | declare-artifact |
 *                           declare-actor (fire-and-forget, shared FIFO — a
 *                           tagged report arriving via request cannot overtake
 *                           an earlier declaration)                           [event]
 *   complete(result)      → idempotent settlement                             [event]
 * report is deliberately a REQUEST (review B8): a caps rejection must fold
 * back into the guest so the run settles as error instead of vanishing.
 * Deliberate redesign vs the NDJSON original (拍板表#7): siteId is a string that
 * matches the journal's (run_id, site_id, ordinal) triple, begin carries
 * meta/args/limits (args already a resolved Json, no JSON text over the wire),
 * and the actor-declaration event is named `declare-actor` (prelude.ts emits
 * exactly this; the original's `create-actor` name is gone).
 */
import type { Json } from '../util/json.ts';
export type GuestOp = 'ask' | 'world-read' | 'world-run' | 'hole' | 'report' | 'publish-artifact';
export interface GuestRequest {
    siteId: string;
    op: GuestOp;
    args: Json;
}
export type GuestEventType = 'log' | 'phase-entered' | 'declare-artifact' | 'declare-actor';
export interface GuestEvent {
    type: GuestEventType;
    args: Json;
}
export interface GuestComplete {
    ok: boolean;
    value?: Json;
    error?: {
        message: string;
        name?: string;
    };
}
export interface WorkerInit {
    meta: {
        name: string;
        description: string;
    };
    args?: Json;
    limits: {
        maxConcurrentAgents: number;
        maxTotalAgents: number;
        maxItemsPerCall: number;
        syncTimeoutMs: number;
    };
}
