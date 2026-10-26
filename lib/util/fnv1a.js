/** FNV-1a 32-bit over trimmed source text — the hole site id (ZCode: hole#xxxxxxxx). */
export function fnv1a32(text) {
    let hash = 2166136261;
    for (const ch of text.trim()) {
        hash ^= ch.codePointAt(0) ?? 0;
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}
/** The hole's site id: content-addressed, stable across script revisions. */
export function holeSiteId(callText) {
    return `hole#${fnv1a32(callText)}`;
}
/** A per-run call-site id for effects the journal records (ask/world/report/artifact). */
export function callSiteId(prefix, ordinal) {
    return `${prefix}#${ordinal}`;
}
