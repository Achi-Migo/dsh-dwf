/**
 * @deepseek-ai/cordis 的最小值替身（T6 扩展）：Service 抽象基类。
 * 真实 cordis 的服务发布/依赖注入行为不在替身范围（单测不起宿主）。
 */

export class Service {
  constructor(ctx, name) {
    this.ctx = ctx
    this.name = name
  }
}
