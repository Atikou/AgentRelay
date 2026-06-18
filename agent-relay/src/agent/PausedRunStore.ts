import type { ChatMessage } from "../model/types.js";
import type { AgentToolStep } from "./toolStep.js";
import type { AgentRunMode, UserPermissionPolicy } from "./RunPolicyTypes.js";

/**
 * 暂停中的 Agent Run 对话快照。
 *
 * 第一性原则：权限暂停不是“结束本轮 + 下次重新喊话”，而是“就地冻结同一段对话”。
 * 用户批准后用这份快照忠实地继续：要么执行那个被批准的工具，要么按已批准计划进入执行阶段，
 * 全程复用同一条 `messages` 链，不再合成假的用户续跑消息、也不再用正则去猜权限。
 */
export interface PausedRunSnapshot {
  runId: string;
  sessionId?: string;
  /** 本轮真实目标（用户原始消息）。 */
  goal: string;
  system?: string;
  /** 暂停时刻的完整对话消息链（含模型发起工具调用的那条 assistant 消息，不含被阻塞工具的结果）。 */
  messages: ChatMessage[];
  /** 已完成的工具步骤（不含被阻塞的那一步）。 */
  steps: AgentToolStep[];
  /** 暂停时已用的模型轮次。 */
  modelTurns: number;
  /** 工具级 JIT 暂停：被阻塞、待批准后执行的工具调用。 */
  pendingAction?: { tool: string; input?: Record<string, unknown> };
  /** 原始运行模式（工具级续跑沿用）。 */
  mode: AgentRunMode;
  /** 原始权限策略（工具级续跑沿用）。 */
  permissionPolicy: UserPermissionPolicy;
  /** 计划→执行交接：恢复后切换到的模式（一般为 implement）。 */
  resumeMode?: AgentRunMode;
  createdAt: string;
}

/**
 * 暂停 Run 快照存储（进程内单例）。键为 runId。
 * 服务重启会丢失，与 `PermissionRequestStore` 同为内存态；这对本地优先后端足够。
 */
export class PausedRunStore {
  private readonly snapshots = new Map<string, PausedRunSnapshot>();

  save(snapshot: PausedRunSnapshot): void {
    this.snapshots.set(snapshot.runId, snapshot);
  }

  get(runId: string): PausedRunSnapshot | null {
    return this.snapshots.get(runId) ?? null;
  }

  /** 取出并移除：恢复开始时调用，避免对同一快照重复续跑。 */
  take(runId: string): PausedRunSnapshot | null {
    const snapshot = this.snapshots.get(runId);
    if (snapshot) this.snapshots.delete(runId);
    return snapshot ?? null;
  }

  delete(runId: string): void {
    this.snapshots.delete(runId);
  }
}

export const defaultPausedRunStore = new PausedRunStore();
