/**
 * 本地模型子 Agent 并发背压：限制同时运行的子任务数，缓解 Ollama 等本地队列拥塞。
 */
export class SubAgentLocalQueueGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maxConcurrent: number) {}

  get stats(): { active: number; maxConcurrent: number; waiting: number } {
    return {
      active: this.active,
      maxConcurrent: this.maxConcurrent,
      waiting: this.waiters.length,
    };
  }

  async acquire(): Promise<() => void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return () => this.release();
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** 进程内单例，由 createAppContext 按 config 初始化。 */
let sharedGate: SubAgentLocalQueueGate | undefined;

export function initSubAgentLocalQueueGate(maxConcurrent: number): SubAgentLocalQueueGate {
  sharedGate = new SubAgentLocalQueueGate(maxConcurrent);
  return sharedGate;
}

export function getSubAgentLocalQueueGate(): SubAgentLocalQueueGate | undefined {
  return sharedGate;
}
