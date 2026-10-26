/**
 * The guest program prelude: facade bridge + stall detection, transplanted
 * from the ZCode guest templates (assets/guest-prelude.js, guest-channel-future.js).
 * The compile layer rewrites effectful facade calls to the `__*` shims below;
 * `agent`/`model`/`channel`/`future`/`phase`/`log`/`hole` stay direct.
 *
 * Host bindings (PTC binding global `dwfHost`):
 *   begin()                   → WorkerInit (review B7: meta/args/limits enter here)
 *   request(msg)              → Promise<Json>; FIFO per arrival; response resolves/rejects
 *   event(msg)                → void; fire-and-forget, shared FIFO with requests
 *   complete(result)          → void; idempotent settlement
 * Stall detection is guest-owned (setImmediate is banned): after the last
 * in-flight request settles, a queued microtask cascade re-runs
 * __checkStalled. The false-positive guard for normal completion is the
 * __settled flag — __start flips it when body() resolves with __pending===0
 * and no parked channel receivers (the await-last-then-return shape). Pending
 * requests or parked receivers leave settled false so stall checks still fire.
 */
export declare const GUEST_PRELUDE_SOURCE: string;
