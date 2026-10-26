/**
 * Guest realm bans, transplanted from the ZCode guest templates: the script
 * realm has no timers, no I/O, no Date/random nondeterminism — the only thing
 * that can wake a suspended script is a host response. Emitted as part of the
 * guest program source (a plain-JS string; runs before the user body).
 */
export declare const REALM_BANS_SOURCE: string;
