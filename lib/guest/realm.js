/**
 * Guest realm bans, transplanted from the ZCode guest templates: the script
 * realm has no timers, no I/O, no Date/random nondeterminism — the only thing
 * that can wake a suspended script is a host response. Emitted as part of the
 * guest program source (a plain-JS string; runs before the user body).
 */
export const REALM_BANS_SOURCE = String.raw `
"use strict";
// —— realm 禁令（guest-template-01 移植）：无定时器、无 I/O、无不确定性 ——
// Date 禁令收窄回三点（拍板表#2，原件 guest-prelude.js:181-201）：只禁 Date.now /
// argless new Date / Math.random；new Date(ts) 与 Date.parse/UTC 原样透传——透传不破坏重放。
var __NativeDate = Date;
class __WorkflowDate extends __NativeDate {
  constructor() {
    if (arguments.length === 0) throw new Error("argless new Date() is banned in a workflow script: runs must be replayable.");
    super(...arguments);
  }
  static now() { throw new Error("Date.now() is banned in a workflow script: runs must be replayable."); }
  static parse(value) { return __NativeDate.parse(value); }
  static UTC() { return __NativeDate.UTC.apply(__NativeDate, arguments); }
}
globalThis.Date = __WorkflowDate;
globalThis.Math = Object.freeze(Object.assign(Object.create(Math), { random: function () { throw new Error("Math.random() is banned in a workflow script: runs must be replayable."); } }));
globalThis.fetch = undefined;
globalThis.setTimeout = undefined;
globalThis.setInterval = undefined;
globalThis.setImmediate = undefined;
globalThis.require = undefined;
globalThis.process = undefined;
`;
