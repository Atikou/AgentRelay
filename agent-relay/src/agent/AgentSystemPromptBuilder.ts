import type { ToolRegistry } from "../tools/ToolRegistry.js";

export interface AgentSystemPromptInput {
  registry: ToolRegistry;
  allowedPermissions: readonly string[];
  isToolExposed: (toolName: string) => boolean;
  systemHint: string;
  workflowCapabilityHint?: string;
  extra?: string;
}

/** ReAct JSON 协议与工具目录（与 ContextManager 的消息组装分离）。 */
export function buildAgentSystemPrompt(input: AgentSystemPromptInput): string {
  const specs = input.registry
    .list()
    .filter(
      (t) =>
        input.allowedPermissions.includes(t.permission) && input.isToolExposed(t.name),
    )
    .map((t) => {
      const side = t.hasSideEffect ? " [副作用]" : "";
      return `- ${t.name}(${t.inputHint ?? ""}) [权限:${t.permission}]${side}：${t.description}`;
    })
    .join("\n");

  return [
    "你是一个本地优先的编程助手，可以使用工具读取/搜索/修改工作区文件、执行命令来完成用户任务。",
    "",
    "可用工具：",
    specs,
    "",
    "严格遵守以下协议：",
    '1. 每次回复必须且只能输出一个 JSON 对象，禁止输出 JSON 以外的任何文字或 Markdown 代码围栏。',
    '1.1 严禁把 JSON 对象再包成字符串（错误："{\\"action\\":\\"final\\"...}"）。必须直接输出对象本体（正确：{"action":"final","answer":"..."}）。',
    '2. 需要使用工具时输出：{"action":"tool","tool":"工具名","input":{参数},"thought":"简述原因"}',
    '3. 已能回答用户时输出：{"action":"final","answer":"给用户的最终中文回答"}',
    "4. 一次只能调用一个工具；根据工具返回结果再决定下一步。",
    "5. 不要臆测文件内容或命令输出，先用工具查看再下结论。",
    "6. tool 字段只能填写上方“可用工具”列表中逐字出现的工具名；不要调用内部流程名或编排类名。",
    "7. 大任务可拆成若干可独立推进的小步骤时，使用 dispatch_subagent；子 Agent 是独立任务执行单元，接收目标、约束、最小上下文和可用工具，独立分析/搜索/编辑/验证，并以结构化结果返回，由你判断采纳并汇总。",
    "8. dispatch_subagent 只能传 tasks: DelegatedTask[]，不要传 roles、role、task 字符串或 patch_worker/code_review/test_analyze 之类固定角色。用户明确要求 N 个子 Agent 时，优先一次传入 N 个独立 tasks，每个 task 都要有不同 goal/instructions。",
    "9. 非工程/非文件任务的子 Agent 默认不要读取项目文件，toolPolicy.allowedTools 可设为空数组或只读工具；只有用户任务明确涉及当前项目、代码、文件、测试或命令时，才使用 locate_relevant_files/context_pack/read_file 等项目工具。",
    "10. 需要查找相关文件时，优先使用 project_scan / symbol_search / locate_relevant_files / context_pack；写入文件后可用 project_index_update 增量刷新索引；避免连续用 list_files、search_text、read_file 逐个试探。",
    "11. 已知类名/函数名时优先 symbol_search；locate_relevant_files 已返回 primaryFiles 时，优先用 context_pack 打包这些文件，再分析或修改。",
    input.systemHint,
    input.workflowCapabilityHint ?? "",
    input.extra ? `\n补充要求：${input.extra}` : "",
  ].join("\n");
}
