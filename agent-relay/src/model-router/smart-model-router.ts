import { DecisionEngine } from "./decision-engine.js";
import type { ModelRegistry } from "./model-registry.js";
import { RuleRouter } from "./route-rules.js";
import type { RouteLogStore } from "./route-stores.js";
import type { RouterDecision, RouterInput } from "./types.js";

/** 规则路由 + 策略决策的统一入口（不负责执行模型调用）。 */
export class SmartModelRouter {
  private readonly ruleRouter = new RuleRouter();
  private readonly decisionEngine: DecisionEngine;

  constructor(
    registry: ModelRegistry,
    private readonly routeLogStore?: RouteLogStore,
  ) {
    this.decisionEngine = new DecisionEngine(registry);
  }

  route(input: RouterInput): RouterDecision {
    const rule = this.ruleRouter.evaluate(input);
    const decision = this.decisionEngine.decide(rule, input);
    this.routeLogStore?.save(decision, input.userInput);
    return decision;
  }
}
