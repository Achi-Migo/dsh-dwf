/**
 * Channel/future guest primitives, transplanted from the ZCode guest template
 * (assets/guest-channel-future.js): unbounded FIFO channels with waiter queues
 * and compaction; send never waits; close is idempotent; a receiver parked on
 * an open empty channel counts toward deadlock detection.
 */
export declare const CHANNEL_PRIMITIVES_SOURCE: string;
