/**
 * Engine loader entry (p0-real-machine ② fix #2): the engine as its own
 * cordis plugin, mirroring the official split where @deepseek-ai/dsh-workflow-ptc
 * is a standalone class package loaded as its own bundle row and the model tool
 * is a separate entry that injects 'workflowEngine'.
 *
 * Why a separate entry: cordis DI requires a context to DECLARE a service in
 * `inject` before accessing it ("cannot get property \"workflowEngine\" without
 * inject", first real-machine boot 2026-10-25), while the previous one-package
 * layout deadlocked — the tool entry's inject waited for the very service its
 * own apply() was supposed to publish ("pending (waiting for service:
 * workflowEngine)"). Two rows resolve it: this entry publishes the service, the
 * dwf entry (src/index.ts) injects it.
 */
import { DwfWorkflowEngine } from './engine/engine.ts';
export { DwfWorkflowEngine };
export default DwfWorkflowEngine;
