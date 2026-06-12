import type { PlanStore } from "./PlanStore.js";
import type { InternalTaskPlan } from "./types.js";

export class PlanApprovalManager {
  constructor(private readonly store: PlanStore) {}

  approve(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    const record = this.store.get(planId, version);
    if (!record) throw new Error("计划不存在");
    this.store.recordApproval({
      planId,
      version,
      approvedBy,
      approvalStatus: "approved",
      comment,
    });
    const updated = this.store.updateStatus(planId, version, "approved");
    if (!updated) throw new Error("审批后更新失败");
    return updated.internal;
  }

  reject(planId: string, version: number, approvedBy: string, comment?: string): InternalTaskPlan {
    const record = this.store.get(planId, version);
    if (!record) throw new Error("计划不存在");
    this.store.recordApproval({
      planId,
      version,
      approvedBy,
      approvalStatus: "rejected",
      comment,
    });
    const updated = this.store.updateStatus(planId, version, "rejected");
    if (!updated) throw new Error("拒绝后更新失败");
    return updated.internal;
  }

  autoApproveForDryRun(planId: string, version: number): InternalTaskPlan {
    return this.approve(planId, version, "system:dry-run", "dry-run auto approve");
  }
}
