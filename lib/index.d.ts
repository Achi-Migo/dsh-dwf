/**
 * dsh-dwf plugin entry: one package, one apply (DESIGN §3.1).
 *
 * Responsibilities, in order:
 *  1. load the engine service explicitly — `ctx.plugin(DwfWorkflowEngine, config)`.
 *     The mirror has no evidence of a host scanning apply-form modules for
 *     Service subclasses (official workflow-ptc ships as a standalone class
 *     package, dsh-contract.md:196), and without the explicit load
 *     `ctx.workflowEngine` never appears, every tool inject fails, and the
 *     plugin is dead on arrival (DESIGN §1.1, risk R5: the ctx.plugin
 *     signature itself is unverifiable in the mirror — first thing to
 *     re-check against real cordis);
 *  2. register the three real tools (create/get/list) plus the six
 *     placeholder tools over one opened journal database;
 *  3. register the usage-guidance prompt section.
 *
 * `jobs` stays an optional injection: the background path reports the missing
 * piece by name when ctx.get('jobs') comes up empty (create.ts, official
 * tool-workflow/index.ts:271-274 behavior).
 * @module @local/dsh-dwf
 */
import type { Context } from '@deepseek-ai/cordis';
import '@deepseek-ai/dsh-subagent';
import '@deepseek-ai/dsh-ptc-runtime';
import '@deepseek-ai/dsh-sandbox-policy';
import '@deepseek-ai/dsh-working-directory';
import '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-system-prompt';
import '@deepseek-ai/dsh-workflow';
import type { Config } from './engine/engine.ts';
export declare const name = "dwf";
export declare const inject: readonly ["tools", "workflowEngine", "systemPrompt"];
export { Config } from './engine/engine.ts';
export declare function apply(ctx: Context, config: Config): void;
