/**
 * 官方包运行时替身入口（评审修订3/B2 立项，拍板表#13 之后仍缺官方 peer 的开发期垫片）。
 *
 * 用法：`node --import ./test/runtime-stubs.mjs <脚本| -e "import('…')">`
 * 本文件在主线程执行，仅做一件事：向 loader 线程注册 resolve 钩子，把 src 里官方包的
 * **值导入**（当前唯一 @deepseek-ai/dsh-llm → util/errors.ts 的 HarnessError）映射到
 * test/runtime-stub-values/ 下的最小值实现——官方 peer 全量 optional、npm 不装，
 * 没有替身时这些文件直跑即 `Cannot find package`（本会话基线实证）。
 *
 * 映射表在 runtime-stub-values/hook.mjs；T6/T7 落码时按需扩展（dsh-workflow 的
 * WorkflowEngine 基类/WorkflowRunId/WorkflowError、cordis 的 Service、dsh-tools 的
 * defineTool、schemastery 的 z）。
 *
 * 边界：替身只服务 node 直跑/单测，不进 tsc 程序（类型面仍由 stubs/dsh.d.ts 承担）；
 * 形状以桩声明为准，不保证与真实包运行时行为一致（PLAN 风险 R6）。
 */
import { register } from 'node:module'

register(new URL('./runtime-stub-values/hook.mjs', import.meta.url))
