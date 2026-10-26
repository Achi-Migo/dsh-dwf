/**
 * resolve 钩子（在 loader 线程运行）：官方包 specifier → 替身模块。
 * 映射表只收「src 值导入过的官方包」；新增导入方（T6/T7）在此追加一行即可。
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const STUBS = {
  // util/errors.ts: `import { HarnessError } from '@deepseek-ai/dsh-llm'`
  '@deepseek-ai/dsh-llm': join(here, 'dsh-llm.mjs'),
  // tool/placeholders.ts（T7）: `import { defineTool } from '@deepseek-ai/dsh-tools'`
  '@deepseek-ai/dsh-tools': join(here, 'dsh-tools.mjs'),
  // T6 扩展：engine/*.ts 值导入面——WorkflowEngine 基类 / WorkflowRunId / WorkflowError
  '@deepseek-ai/dsh-workflow': join(here, 'dsh-workflow.mjs'),
  // T6 扩展：Service 基类（DwfWorkflowEngine 间接继承；单测不起宿主）
  '@deepseek-ai/cordis': join(here, 'cordis.mjs'),
  // T6 扩展：z.object/string/natural/boolean + default（engine.ts static Config）
  '@deepseek-ai/schemastery': join(here, 'schemastery.mjs'),
}

export function resolve(specifier, context, nextResolve) {
  const mapped = STUBS[specifier]
  if (mapped !== undefined) {
    return { url: pathToFileURL(mapped).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
