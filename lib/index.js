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
import { DatabaseSync } from 'node:sqlite';
// Context slot augmentations live in the owning packages' type entries
// (ctx.subagents / ctx.ptcRuntime / ctx.sandboxPolicy / ctx.workingDirectory /
// ctx.tools / ctx.systemPrompt / ctx.workflowEngine). The ambient stub that
// pre-placed them is retired; these side-effect imports load each package's
// declarations once, program-wide, from the single entry.
import '@deepseek-ai/dsh-subagent';
import '@deepseek-ai/dsh-ptc-runtime';
import '@deepseek-ai/dsh-sandbox-policy';
import '@deepseek-ai/dsh-working-directory';
import '@deepseek-ai/dsh-tools';
import '@deepseek-ai/dsh-system-prompt';
import '@deepseek-ai/dsh-workflow';
import { resolveJournalPath } from "./engine/engine.js";
import { initSchema } from "./journal/schema.js";
import { createWorkflowTool } from "./tool/create.js";
import { getWorkflowRunTool } from "./tool/get.js";
import { listWorkflowRunsTool } from "./tool/list.js";
import { placeholderTools } from "./tool/placeholders.js";
export const name = 'dwf';
// p0-real-machine ② fix #2: injection RESTORED — the engine is now its own
// loader entry (src/engine-entry.ts, bundle row `dwf-engine` before this row),
// exactly the official split (workflow-ptc publishes, tool-workflow injects).
// cordis DI both requires this inject for ctx.workflowEngine access and
// resolves it because the engine no longer depends on this apply() running.
export const inject = ['tools', 'workflowEngine', 'systemPrompt'];
export { Config } from "./engine/engine.js";
// The module augmentations (Context.workflowEngine / Context slot services /
// SessionEventMap dwf/*) live in the owning packages or, for dwf/*, in
// src/tool/recorder.ts — never duplicated here.
export function apply(ctx, config) {
    // ① Engine service: loaded by the dedicated `dwf-engine` bundle row
    //    (src/engine-entry.ts) — NOT here. The old nested ctx.plugin() load
    //    could not satisfy cordis DI (see the inject comment above).
    // One journal database for the read-side tools; the schema is created once
    // at plugin start, before any tool or engine write. The path comes from
    // resolveJournalPath (engine.ts) — the single resolver both sides share, so
    // this handle and the engine's handle always land on the same database file.
    // An empty dbPath has no host data-dir convention to fall back on yet
    // (DESIGN §1.3 default is '<plugin-data>/dwf.db') — a cwd-relative ./dwf.db
    // keeps the two on one database, which an in-memory fallback would not.
    const dbFile = resolveJournalPath(config.dbPath);
    if (config.dbPath === '') {
        ctx.logger.warn('dwf: config.dbPath is empty; falling back to ./dwf.db relative to the process cwd');
    }
    const db = new DatabaseSync(dbFile);
    initSchema(db);
    // ② Model-facing tools.
    ctx.tools.register(createWorkflowTool(ctx, {
        toolName: config.toolName,
        maxResultChars: config.maxResultChars,
        enableRunInBackground: config.enableRunInBackground,
    }));
    ctx.tools.register(getWorkflowRunTool(db));
    ctx.tools.register(listWorkflowRunsTool(db));
    for (const tool of placeholderTools())
        ctx.tools.register(tool);
    // ③ Usage policy ships with the tool (official :325-330 — tool guidance
    // lives in tool plugins as prompt sections, not in the deployment persona).
    ctx.systemPrompt.section({
        name: `tool:${config.toolName}`,
        order: ctx.systemPrompt.getSectionOrder('TOOL_WORKFLOW'),
        text: `Use the ${config.toolName} tool ONLY when the user explicitly asks for a workflow or for large multi-agent orchestration: you write a TypeScript-checked script (the tool description documents the exact facade) that fans work out across many subagents with phases, recorded deterministic world access, and structured results. For one or two delegations, prefer plain subagent calls.`,
    });
}
