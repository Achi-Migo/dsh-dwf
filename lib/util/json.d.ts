/** Lossless JSON snapshot across the guest↔host boundary (dsh realm convention). */
export type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
export declare class MaterializeError extends Error {
    constructor(message: string);
}
/**
 * Snapshot a value into lossless JSON. Top-level undefined, special prototypes,
 * functions, symbols, cycles, sparse arrays, non-finite numbers and nested
 * undefined are rejected (workflow-ptc realm.ts discipline). MaterializeError
 * is defined locally on purpose: this file must stay importable with zero
 * official-package value imports (guest/journal smoke dependency surface).
 */
export declare function snapshotJsonValue(value: unknown, depth?: number): Json;
