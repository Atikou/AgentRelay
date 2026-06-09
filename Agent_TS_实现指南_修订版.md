# Agent TodoList 完整实现指南（TypeScript 修订版）

> 本文档基于原始《Agent TodoList 完整实现指南》修订。  
> 修订目标：将主实现语言统一为 **TypeScript / Node.js**，收缩 MVP 范围，修正原文中过早引入 Python/LangGraph/Celery/LiteLLM 造成的技术路线不一致问题，并补充更适合长期维护的工程边界。  
> **版本**：1.1  
> **最后更新**：2026-06-08

---

## 目录

1. [项目可行性分析](#1-项目可行性分析)
2. [主要不足与修订原则](#2-主要不足与修订原则)
3. [技术选型与语言推荐](#3-技术选型与语言推荐)
4. [总体架构设计](#4-总体架构设计)
5. [实现顺序（八个里程碑）](#5-实现顺序八个里程碑)
6. [附录 A：关键模块 TypeScript 代码骨架](#附录-a关键模块-typescript-代码骨架)
7. [附录 B：配置文件示例](#附录-b配置文件示例)
8. [附录 C：里程碑验收检查清单](#附录-c里程碑验收检查清单)

---

## 1. 项目可行性分析

### 1.1 总体结论

**可行，但不能一开始按“完整平台”开发。**

该项目本质上是一个本地优先的 Coding Agent / Project Agent 系统，目标包括：

- 调用本地模型和远程模型。
- 读取、搜索、修改项目文件。
- 执行 Shell 命令。
- 管理任务计划和任务状态。
- 支持后台任务、通知队列和日志追踪。
- 后续扩展子 Agent、上下文压缩、长期记忆和审计回放。

这些能力都可以工程化实现，没有根本不可解的问题。但完整版本复杂度很高，不适合从第一天就全部实现。

### 1.2 修订后的核心判断

| 项目 | 判断 |
|---|---|
| 可行性 | 高 |
| 工程复杂度 | 高 |
| MVP 必要性 | 非常高 |
| 第一版主语言 | TypeScript / Node.js |
| Python 定位 | 后期模型、语音、向量服务的辅助服务 |
| C# / WPF 定位 | 后期桌面 UI |
| Rust 定位 | 后期高安全 Shell 执行器或沙箱组件 |

---

## 2. 主要不足与修订原则

### 2.1 原方案主要不足

#### 1. 主语言前后不一致

原方案在技术选型中推荐 Python 主干，但你的实际需求更偏向：

- 本地项目文件操作。
- TypeScript / Laya / Node 脚本生态。
- CLI 工具。
- VS Code / Cursor / Codex 类体验。
- 后期可能接 Electron 或 WPF 桌面端。

因此主 Agent 使用 TypeScript / Node.js 更合适。

#### 2. MVP 范围过大

原方案从早期就引入：

- LangGraph。
- LiteLLM。
- Celery。
- 子 Agent。
- 向量数据库。
- 沙箱。
- OpenTelemetry。
- Prometheus。
- Docker 执行器。
- 长期记忆。

这些不是不能做，而是会导致第一版很难闭环。

第一版应该先完成：

```text
用户输入
  → 模型调用
  → 工具调用
  → 文件/命令执行
  → 状态记录
  → 结果反馈
```

#### 3. 子 Agent 过早

子 Agent 会立刻引入：

- 并发冲突。
- 文件修改合并。
- 权限继承。
- 上下文隔离。
- 结果冲突检测。
- 超时和取消。

建议放到 M5 或更后。

#### 4. 长期记忆过早

长期记忆、向量库、embedding 检索不是第一版的必要能力。

第一版只需要：

- 当前任务上下文。
- 当前计划。
- 当前工具调用结果。
- 历史摘要。
- 本地 JSONL 日志。

#### 5. 没有明确“不能做什么”

Agent 项目很容易无限扩张，所以每个阶段都必须明确边界。

MVP 阶段暂不支持：

- 自动部署。
- 自动推送代码。
- 多 Agent 并行改同一批文件。
- 自动执行高风险命令。
- 自主联网搜索。
- 自主长期循环任务。
- 未经确认删除文件。

---

## 3. 技术选型与语言推荐

### 3.1 主语言：TypeScript / Node.js

主 Agent 推荐使用：

```text
TypeScript + Node.js
```

原因：

- 文件系统操作方便。
- Shell 命令执行方便。
- JSON Schema / Zod 类型校验成熟。
- 适合写 CLI、后台服务、桌面端桥接服务。
- 和 Laya / VS Code / Electron / Web 技术栈一致。
- 更适合实现工具协议、任务状态、模型路由和插件系统。

推荐运行环境：

```text
Node.js >= 20
TypeScript >= 5
pnpm
tsx
zod
commander
better-sqlite3
execa
fast-glob
chokidar
```

### 3.2 Python 的定位

Python 不作为主 Agent 核心，但可以作为辅助服务：

| 模块 | 是否建议 Python |
|---|---|
| STT / TTS | 推荐 |
| 本地模型实验 | 推荐 |
| embedding 服务 | 推荐 |
| 向量检索服务 | 可选 |
| 主任务编排 | 不推荐第一版使用 |
| 文件修改 / Shell 调度 | 不推荐作为主实现 |

### 3.3 C# / WPF 的定位

如果后续要做桌面 UI：

```text
WPF = UI 层
TypeScript Agent = 后端核心
二者通过 HTTP / WebSocket / stdio 通信
```

不要把 Agent 核心全部写进 WPF，否则后面工具系统、模型路由、插件扩展会变重。

### 3.4 Rust 的定位

Rust 不建议第一版使用。

后期可以用于：

- 高安全命令执行器。
- 沙箱进程。
- 高性能文件索引。
- 本地 CLI 加速。

---

## 4. 总体架构设计

### 4.1 推荐架构

```text
┌─────────────────────────────────────────────────────────────┐
│                        用户交互层                            │
│     CLI / Electron / WPF / Web UI / VS Code 插件             │
└─────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript Agent Core                    │
│                                                             │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ │
│  │ Planner    │ │ Executor   │ │ ToolSystem │ │ State    │ │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘ │
│                                                             │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐ │
│  │ Router     │ │ Context    │ │ Permission │ │ Trace    │ │
│  └────────────┘ └────────────┘ └────────────┘ └──────────┘ │
└─────────────────────────────────────────────────────────────┘
                                │
        ┌───────────────────────┼───────────────────────┐
        ▼                       ▼                       ▼
┌───────────────┐       ┌───────────────┐       ┌───────────────┐
│ Model APIs    │       │ Local Tools   │       │ Storage       │
│ OpenAI compat │       │ file/shell/git │       │ SQLite/JSONL  │
│ Ollama/LM     │       │ background cmd │       │ logs/traces   │
└───────────────┘       └───────────────┘       └───────────────┘
```

### 4.2 推荐目录结构

```text
agent-relay/   # npm 包名 agent-relay；可运行代码目录
├─ package.json
├─ tsconfig.json
├─ pnpm-workspace.yaml
├─ config/
│  ├─ default.json
│  ├─ local-only.json
│  └─ cloud.json
├─ data/
│  ├─ agent.db
│  ├─ logs/
│  └─ traces/
├─ src/
│  ├─ cli/
│  │  └─ main.ts
│  ├─ agent/
│  │  ├─ Agent.ts
│  │  ├─ Planner.ts
│  │  ├─ Executor.ts
│  │  └─ AgentLoop.ts
│  ├─ model/
│  │  ├─ ModelClient.ts
│  │  ├─ OpenAICompatibleClient.ts
│  │  ├─ OllamaClient.ts
│  │  └─ ModelRouter.ts
│  ├─ tools/
│  │  ├─ Tool.ts
│  │  ├─ FileTools.ts
│  │  ├─ ShellTool.ts
│  │  ├─ GitTools.ts
│  │  └─ ToolRegistry.ts
│  ├─ task/
│  │  ├─ Task.ts
│  │  ├─ TaskStore.ts
│  │  └─ TaskStateMachine.ts
│  ├─ background/
│  │  ├─ BackgroundTaskManager.ts
│  │  └─ NotificationQueue.ts
│  ├─ context/
│  │  ├─ ContextManager.ts
│  │  └─ Summarizer.ts
│  ├─ permission/
│  │  ├─ PermissionPolicy.ts
│  │  └─ RiskChecker.ts
│  ├─ trace/
│  │  └─ TraceLogger.ts
│  └─ types/
│     └─ index.ts
└─ tests/
   ├─ model-router.test.ts
   ├─ tool-registry.test.ts
   ├─ permission.test.ts
   └─ agent-loop.test.ts
```

---

## 5. 实现顺序（八个里程碑）

## M1：基础 Agent 循环

### 目标

实现最小闭环：

```text
用户输入
  → 模型调用
  → 解析模型返回
  → 调用工具
  → 记录日志
  → 输出结果
```

### 必做任务

- [ ] 初始化 TypeScript 项目。
- [ ] 实现 OpenAI-compatible 模型客户端。
- [ ] 实现 Ollama 模型客户端。
- [ ] 实现统一 `ModelClient` 接口。
- [ ] 定义 `Tool` 协议。
- [ ] 实现 `read_file`、`list_files`、`search_text` 三个只读工具。
- [ ] 实现 `shell_run` 工具，但默认需要用户确认。
- [ ] 实现 CLI 输入循环。
- [ ] 每轮记录 `trace.jsonl`。

### 暂不做

- 不做子 Agent。
- 不做向量库。
- 不做自动长期记忆。
- 不做复杂 UI。
- 不做自动部署。

### 验收

```text
用户：读取 package.json 并告诉我项目名
Agent：调用 read_file
Agent：返回 package.json 中的 name 字段
Trace：记录模型调用和工具调用
```

---

## M2：模型路由

### 目标

支持本地模型和远程模型，并可以根据简单策略选择。

### 必做任务

- [ ] 实现 `ModelRouter`。
- [ ] 支持配置默认模型。
- [ ] 支持策略：
  - [ ] `local-first`
  - [ ] `cloud-first`
  - [ ] `privacy-first`
  - [ ] `quality-first`
- [ ] 记录每次模型调用耗时。
- [ ] 记录失败原因。
- [ ] 远程失败时可 fallback 到本地。
- [ ] 支持用户强制指定模型。

### 暂不做

- 不做复杂质量评分。
- 不做多模型互审。
- 不做自动成本最优化。
- 不做 Prometheus 指标。

---

## M3：计划模式与任务模式

### 目标

Agent 能先生成计划，再根据确认执行。

### 必做任务

- [ ] 实现 `Plan`、`PlanStep` 数据结构。
- [ ] 计划模式只允许只读工具。
- [ ] 任务模式允许写文件和执行命令，但需要权限检查。
- [ ] 每个步骤有明确状态。
- [ ] 支持用户批准、拒绝、修改计划。
- [ ] 支持中断任务。
- [ ] 支持失败后暂停，等待用户决定重试或跳过。

### 推荐状态

```text
pending
running
blocked
completed
failed
cancelled
```

### 关键原则

计划模式不能直接修改文件。

任务模式执行前必须检查：

- 是否写文件。
- 是否删除文件。
- 是否运行命令。
- 是否访问网络。
- 是否会覆盖配置。
- 是否会安装依赖。

---

## M4：后台任务与通知队列

### 目标

支持长时间命令后台运行，例如：

- `npm run dev`
- `npm run build`
- `pnpm test`
- `tsc --watch`
- 本地服务启动

### 必做任务

- [ ] 使用 `execa` 或 `child_process.spawn` 启动后台任务。
- [ ] 记录 stdout / stderr。
- [ ] 支持查询状态。
- [ ] 支持取消任务。
- [ ] 命令完成后写入通知队列。
- [ ] 主 Agent 在安全点消费通知。
- [ ] 通知持久化到 SQLite 或 JSONL。

### 安全点定义

Agent 不应在写文件中途被通知打断。建议只在这些位置消费通知：

- 新一轮用户输入前。
- 单个 PlanStep 完成后。
- 工具调用完成后。
- 后台任务状态查询时。

---

## M5：子 Agent 与上下文隔离

### 目标

在主 Agent 稳定后，再引入子 Agent。

### 第一版子 Agent 只做只读

推荐从这两个角色开始：

```text
CodeReviewAgent：只读审查代码
TestAnalyzeAgent：只读分析测试输出
```

暂时不要让子 Agent 写文件。

### 必做任务

- [ ] 子 Agent 独立上下文。
- [ ] 子 Agent 独立工具权限。
- [ ] 父 Agent 显式授予权限。
- [ ] 子 Agent 结果汇总。
- [ ] 超时取消。
- [ ] 父子调用链记录。

### 暂不做

- 不让多个子 Agent 同时修改同一文件。
- 不做复杂冲突合并。
- 不做无限递归派生。

---

## M6：上下文压缩与持久化

### 目标

让 Agent 长时间运行后仍然能继续任务。

### 第一版不要上向量库

第一版上下文压缩只做：

- 保留当前任务目标。
- 保留当前计划。
- 保留已修改文件列表。
- 保留失败原因。
- 保留关键工具结果。
- 压缩历史对话为摘要。

### 必做任务

- [ ] `ContextManager` 管理上下文层级。
- [ ] 超过 token 预算时生成摘要。
- [ ] 摘要写入任务状态。
- [ ] 重启后恢复未完成任务。
- [ ] 工具大输出只保留摘要和文件路径。

### 后续再做

- embedding。
- Chroma / Qdrant。
- 项目知识库。
- 长期用户记忆。

---

## M7：安全、审计与测试

### 目标

使 Agent 可以长期可靠运行。

### 必做任务

- [ ] 敏感信息检测。
- [ ] 日志脱敏。
- [ ] 命令 allowlist / denylist。
- [ ] 写文件前生成 patch。
- [ ] 高风险操作二次确认。
- [ ] 工具调用审计日志。
- [ ] 单元测试覆盖核心模块。
- [ ] 集成测试覆盖一次完整任务执行。
- [ ] 支持 trace 导出。

### 高风险操作

默认需要确认：

- 删除文件。
- 覆盖配置文件。
- 安装依赖。
- 修改 `.env`。
- 执行 `git push`。
- 执行部署命令。
- 执行递归删除。
- 修改大量文件。
- 网络下载脚本并执行。

---

## M8：定时与事件触发

### 目标

在主循环、后台任务和通知队列稳定后，引入定时触发和事件触发，让 Agent 能在无人值守时按计划或按事件自动执行任务。

> 这是原始需求中明确要求的能力，但属于较高阶功能，必须在 M4 通知队列稳定后再做，否则触发器会和主循环、安全点消费产生竞态。

### 必做任务

- [ ] 实现 `Scheduler`，统一管理触发器。
- [ ] 支持一次性定时任务（指定时间点执行一次）。
- [ ] 支持周期性任务（固定间隔）。
- [ ] 支持 cron 表达式（推荐 `croner` 或 `node-cron`）。
- [ ] 支持事件触发：
  - [ ] 文件变更（复用 `chokidar`）。
  - [ ] 后台任务完成（复用 M4 通知队列）。
  - [ ] Git 状态变化。
- [ ] 触发后不直接执行高风险操作，而是生成一个待执行任务进入任务队列。
- [ ] 触发产生的任务同样走计划模式 / 权限检查（不能绕过 M3、M7 的安全约束）。
- [ ] 支持触发器的暂停、恢复、取消。
- [ ] 触发器定义持久化，进程重启后恢复。
- [ ] 同一触发器避免重复触发（加去重 / 锁）。

### 关键原则

- 触发器只负责「在合适时机产生任务」，不负责「绕过安全直接干活」。
- 自动触发的任务默认进入需要确认的队列，除非用户显式开启「无人值守白名单」。
- 错过执行时间的补偿策略要可配置：跳过、立即补一次、或忽略。

### 暂不做

- 不做分布式调度。
- 不做跨机器触发。
- 不做复杂的 DAG 定时编排（留到任务编排成熟后）。

---

# 附录 A：关键模块 TypeScript 代码骨架

## A.1 模型客户端接口

```ts
export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    name?: string;
    toolCallId?: string;
}

export interface ToolCall {
    id: string;
    name: string;
    arguments: unknown;
}

export interface ModelResponse {
    content: string;
    toolCalls: ToolCall[];
    modelName: string;
    latencyMs: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
}

export interface ModelClient {
    name: string;

    chat(params: {
        messages: ChatMessage[];
        tools?: ToolDefinition[];
        signal?: AbortSignal;
    }): Promise<ModelResponse>;
}
```

## A.2 OpenAI-compatible 客户端

```ts
import OpenAI from "openai";
import { performance } from "node:perf_hooks";

export class OpenAICompatibleClient implements ModelClient {
    public readonly name: string;
    private readonly client: OpenAI;
    private readonly model: string;

    constructor(options: {
        name: string;
        model: string;
        apiKey: string;
        baseURL?: string;
    }) {
        this.name = options.name;
        this.model = options.model;
        this.client = new OpenAI({
            apiKey: options.apiKey,
            baseURL: options.baseURL,
        });
    }

    async chat(params: {
        messages: ChatMessage[];
        tools?: ToolDefinition[];
        signal?: AbortSignal;
    }): Promise<ModelResponse> {
        const start = performance.now();

        const response = await this.client.chat.completions.create(
            {
                model: this.model,
                messages: params.messages,
                tools: params.tools?.map(toOpenAITool),
            },
            {
                signal: params.signal,
            }
        );

        const latencyMs = performance.now() - start;
        const choice = response.choices[0];

        return {
            content: choice.message.content ?? "",
            toolCalls: parseOpenAIToolCalls(choice.message.tool_calls),
            modelName: this.model,
            latencyMs,
            inputTokens: response.usage?.prompt_tokens,
            outputTokens: response.usage?.completion_tokens,
        };
    }
}
```

## A.3 工具协议

```ts
import { z } from "zod";

export type ToolPermission =
    | "read"
    | "write"
    | "shell"
    | "network"
    | "dangerous";

export interface ToolContext {
    workspaceRoot: string;
    taskId: string;
    signal?: AbortSignal;
}

export interface ToolDefinition<
    TInput extends z.ZodTypeAny = z.ZodTypeAny,
    TOutput = unknown
> {
    name: string;
    description: string;
    inputSchema: TInput;
    permission: ToolPermission;
    hasSideEffect: boolean;
    timeoutMs?: number;

    execute(input: z.infer<TInput>, context: ToolContext): Promise<TOutput>;
}
```

## A.4 文件读取工具

```ts
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const ReadFileTool: ToolDefinition<
    z.ZodObject<{ path: z.ZodString }>,
    { path: string; content: string }
> = {
    name: "read_file",
    description: "读取工作区内的文本文件。",
    permission: "read",
    hasSideEffect: false,
    inputSchema: z.object({
        path: z.string(),
    }),

    async execute(input, context) {
        const root = path.resolve(context.workspaceRoot);
        const fullPath = path.resolve(root, input.path);

        const relative = path.relative(root, fullPath);
        const isInside =
            relative === "" ||
            (!relative.startsWith("..") && !path.isAbsolute(relative));

        if (!isInside) {
            throw new Error("禁止读取工作区之外的文件。");
        }

        const content = await fs.readFile(fullPath, "utf-8");

        return {
            path: input.path,
            content,
        };
    },
};
```

## A.5 Shell 工具

```ts
import { execa } from "execa";
import { z } from "zod";

export const ShellRunTool: ToolDefinition<
    z.ZodObject<{
        command: z.ZodString;
        cwd: z.ZodOptional<z.ZodString>;
    }>,
    {
        exitCode: number;
        stdout: string;
        stderr: string;
    }
> = {
    name: "shell_run",
    description: "在工作区内执行 Shell 命令。高风险命令需要确认。",
    permission: "shell",
    hasSideEffect: true,
    timeoutMs: 60_000,
    inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
    }),

    async execute(input, context) {
        const risk = checkCommandRisk(input.command);

        if (risk.level === "dangerous") {
            throw new Error(`危险命令被拦截：${risk.reason}`);
        }

        const result = await execa(input.command, {
            shell: true,
            cwd: input.cwd ?? context.workspaceRoot,
            timeout: 60_000,
            reject: false,
            signal: context.signal,
        });

        return {
            exitCode: result.exitCode ?? 0,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    },
};
```

## A.6 任务结构

```ts
export type TaskStatus =
    | "pending"
    | "running"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";

export interface AgentTask {
    id: string;
    title: string;
    userGoal: string;
    status: TaskStatus;
    plan: PlanStep[];
    createdAt: number;
    updatedAt: number;
}

export interface PlanStep {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    requiredPermissions: ToolPermission[];
    toolCalls: ToolCallRecord[];
    acceptance?: string;
}

export interface ToolCallRecord {
    id: string;
    toolName: string;
    input: unknown;
    output?: unknown;
    error?: string;
    status: "success" | "failed";
    startedAt: number;
    endedAt: number;
}
```

## A.7 Trace 日志

```ts
import { createWriteStream } from "node:fs";
import path from "node:path";

export class TraceLogger {
    private stream;

    constructor(logDir: string) {
        this.stream = createWriteStream(path.join(logDir, "trace.jsonl"), {
            flags: "a",
            encoding: "utf-8",
        });
    }

    write(event: Record<string, unknown>): void {
        this.stream.write(
            JSON.stringify({
                time: new Date().toISOString(),
                ...event,
            }) + "\n"
        );
    }
}
```

## A.8 模型路由器

```ts
export type RoutingStrategy =
    | "local-first"
    | "cloud-first"
    | "privacy-first"
    | "quality-first";

export class ModelRouter {
    constructor(
        private readonly clients: ModelClient[],
        private readonly strategy: RoutingStrategy,
        private readonly trace: TraceLogger
    ) {}

    async chat(params: {
        messages: ChatMessage[];
        tools?: ToolDefinition[];
        sensitive?: boolean;
    }): Promise<ModelResponse> {
        const candidates = this.selectCandidates(params.sensitive);

        let lastError: unknown;

        for (const client of candidates) {
            try {
                const response = await client.chat({
                    messages: params.messages,
                    tools: params.tools,
                });

                this.trace.write({
                    type: "model_call",
                    model: response.modelName,
                    latencyMs: response.latencyMs,
                    strategy: this.strategy,
                });

                return response;
            } catch (error) {
                lastError = error;

                this.trace.write({
                    type: "model_call_failed",
                    model: client.name,
                    error: String(error),
                });
            }
        }

        throw lastError;
    }

    private selectCandidates(sensitive?: boolean): ModelClient[] {
        if (sensitive || this.strategy === "privacy-first") {
            return this.clients.filter((client) => client.name.includes("local"));
        }

        if (this.strategy === "cloud-first" || this.strategy === "quality-first") {
            return [
                ...this.clients.filter((client) => client.name.includes("cloud")),
                ...this.clients.filter((client) => client.name.includes("local")),
            ];
        }

        return [
            ...this.clients.filter((client) => client.name.includes("local")),
            ...this.clients.filter((client) => client.name.includes("cloud")),
        ];
    }
}
```

---

# 附录 B：配置文件示例

```json
{
  "workspaceRoot": "E:/LayaProject/MarbleSort",
  "models": {
    "default": "local-qwen",
    "clients": [
      {
        "name": "local-qwen",
        "provider": "ollama",
        "baseUrl": "http://localhost:11434",
        "model": "qwen2.5-coder:7b"
      },
      {
        "name": "cloud-openai",
        "provider": "openai-compatible",
        "baseUrl": "https://api.openai.com/v1",
        "apiKeyEnv": "OPENAI_API_KEY",
        "model": "gpt-4.1"
      }
    ]
  },
  "routing": {
    "strategy": "local-first",
    "fallback": true
  },
  "tools": {
    "allow": [
      "read_file",
      "list_files",
      "search_text",
      "shell_run"
    ],
    "shell": {
      "requireConfirm": true,
      "timeoutMs": 60000,
      "denyCommands": [
        "rm -rf /",
        "sudo",
        "format",
        "del /s /q",
        "git push",
        "npm publish"
      ]
    }
  },
  "security": {
    "redactSecrets": true,
    "sensitivePatterns": [
      "sk-[A-Za-z0-9]{20,}",
      "-----BEGIN .* PRIVATE KEY-----",
      "AKIA[0-9A-Z]{16}"
    ]
  },
  "storage": {
    "sqlite": "data/agent.db",
    "traceFile": "data/traces/trace.jsonl"
  }
}
```

---

# 附录 C：里程碑验收检查清单

## M1 验收

- [ ] CLI 可以连续对话至少 10 轮。
- [ ] 能读取文件。
- [ ] 能搜索文本。
- [ ] 能调用 Shell 工具但需要确认。
- [ ] 每次模型调用和工具调用都写入 trace。

## M2 验收

- [ ] 可以配置本地模型和远程模型。
- [ ] `local-first` 策略优先使用本地模型。
- [ ] `cloud-first` 策略优先使用远程模型。
- [ ] 远程模型失败时可以 fallback。
- [ ] 敏感任务不发送到远程模型。

## M3 验收

- [ ] Agent 能生成结构化计划。
- [ ] 计划模式不能写文件。
- [ ] 用户拒绝计划后不会执行。
- [ ] 任务状态可以保存。
- [ ] 失败步骤会进入 blocked 或 failed。

## M4 验收

- [ ] 后台任务运行时可以继续输入其他命令。
- [ ] 可以查询后台任务状态。
- [ ] 可以取消后台任务。
- [ ] 任务完成后通知队列收到消息。
- [ ] Agent 在安全点消费通知。

## M5 验收

- [ ] 能派生只读子 Agent。
- [ ] 子 Agent 无法调用写文件工具。
- [ ] 子 Agent 拥有独立上下文。
- [ ] 父 Agent 能汇总子 Agent 结果。

## M6 验收

- [ ] 长对话可以压缩为摘要。
- [ ] 工具大输出不会全部塞入上下文。
- [ ] 重启后能恢复未完成任务。
- [ ] 上下文中保留关键决策和失败原因。

## M7 验收

- [ ] 日志中不会出现明文 API Key。
- [ ] 高风险命令会被拦截或要求确认。
- [ ] 写文件前能生成变更摘要或 patch。
- [ ] 核心模块有单元测试。
- [ ] 能导出完整 trace 进行复盘。

## M8 验收

- [ ] 能注册一次性、周期性和 cron 定时任务。
- [ ] 文件变更能触发对应任务。
- [ ] 后台任务完成能触发后续任务。
- [ ] 触发产生的任务仍走权限检查，不会绕过确认。
- [ ] 重启后触发器定义可以恢复。
- [ ] 同一触发器不会在一个周期内重复触发。

---

# 结语

本项目建议以 **TypeScript / Node.js** 作为主 Agent 核心，先完成 CLI MVP，再扩展桌面 UI、本地模型服务、子 Agent、上下文压缩和审计系统。

第一版最重要的不是功能多，而是形成稳定闭环：

```text
能理解任务
能读项目
能计划
能安全地改文件
能运行命令
能记录过程
能失败后恢复
```

只要这个闭环稳定，后面的模型路由、子 Agent、长期记忆和桌面 UI 都可以逐步叠加。
