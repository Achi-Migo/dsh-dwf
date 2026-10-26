/**
 * @deepseek-ai/dsh-workflow 的最小值替身（T6 扩展，形状对齐 stubs/dsh.d.ts 的
 * workflow 段声明）：WorkflowRunId 工厂函数、WorkflowError 类（extends Error 携带
 * code/fatal）、WorkflowEngine 可继承基类（emitWorkflowEvent 为空实现）。
 * R6：替身≠真包——接入真实 dsh 后必须用真实 peer 包复跑全部单测。
 */

/** 品牌化 run id 工厂（桩：declare function WorkflowRunId(id: string): WorkflowRunId）。 */
export function WorkflowRunId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('WorkflowRunId requires a non-empty string')
  return id
}

/** WorkflowError（workflow-seam/index.ts:130-139：extends HarnessError，携带 fatal，默认 true）。 */
export class WorkflowError extends Error {
  constructor(message, code, options) {
    super(message, options)
    this.name = 'WorkflowError'
    this.code = code
    this.fatal = options?.fatal ?? true
  }
}

/** WorkflowEngine 抽象基类（workflow-seam/index.ts:157-160：以 'workflowEngine' 名注册的 Service）。 */
export class WorkflowEngine {
  constructor(ctx) {
    this.ctx = ctx
  }

  /** seam 的逐监听器容错派发在真实基类里；替身最小化为 no-op（单测不依赖事件出站）。 */
  emitWorkflowEvent() {}
}
