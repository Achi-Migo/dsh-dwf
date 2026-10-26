/** FNV-1a 32-bit over trimmed source text — the hole site id (ZCode: hole#xxxxxxxx). */
export declare function fnv1a32(text: string): string;
/** The hole's site id: content-addressed, stable across script revisions. */
export declare function holeSiteId(callText: string): string;
/** A per-run call-site id for effects the journal records (ask/world/report/artifact). */
export declare function callSiteId(prefix: string, ordinal: number): string;
