/**
 * @deepseek-ai/dsh-llm 最小值替身：errors.ts 只消费 HarnessError(message, code)。
 * 形状按 stubs/dsh.d.ts 的声明对齐（Error 子类 + code 字段）；语义对齐属接入期动作（R6）。
 */
export class HarnessError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'HarnessError'
    this.code = code
  }
}
