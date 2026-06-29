# AgentRelay 模型路由：Level 与多模态 Capability 分层设计说明

## 1. 问题背景

当前模型路由中已有 `ModelLevel`，大致分为：

| 等级 | 典型用途 |
|---|---|
| Level 0 | 规则直答、不调用模型 |
| Level 1 | 闲聊、简单问答、轻量本地模型 |
| Level 2 | 技术问答、一般远程 API |
| Level 3 | 架构设计、代码修改、高风险任务 |

这个分级可以表达：

```text
模型大概有多强
```

但无法表达：

```text
模型能不能看图
能不能识别 UI 截图
能不能读图片里的文字
能不能看架构图
能不能读 PDF
能不能处理音频
能不能生成图片
能不能调用工具
能不能稳定输出 JSON
```

因此，当项目加入多模态模型后，不能继续只依赖 `ModelLevel`。

核心结论：

> **Level 表示模型强弱；Capability 表示模型会不会某项能力。**

---

## 2. 为什么 Level 不够

两个模型都可以是 Level 3，但能力完全不同：

```text
cloud-deepseek
Level 3
擅长代码、架构、文本推理
但可能不支持图片输入

vision-model
Level 3
支持图片、截图、OCR、UI 分析
也能做复杂推理
```

如果只看 Level：

```text
Level 3 = 可以处理复杂任务
```

系统会误以为：

```text
Level 3 = 也能看图
```

这是错误的。

正确分层应该是：

```text
Level 3 = 复杂推理能力强
capabilities.image = true = 能接收图片输入
capabilities.uiScreenshot = true = 擅长 UI 截图分析
capabilities.ocr = true = 能读图片文字
```

---

## 3. 推荐路由模型

模型路由应从：

```text
ModelLevel 0 / 1 / 2 / 3
```

升级为：

```text
ModelLevel
+ CapabilityProfile
+ PrivacyPolicy
+ CostPolicy
+ RolePolicy
```

也就是：

| 维度 | 作用 |
|---|---|
| `level` | 判断模型是否足够强 |
| `capabilities` | 判断模型是否会做这类任务 |
| `privacy` | 判断任务能不能发给该模型 |
| `cost` | 判断成本是否合适 |
| `roles` | 判断模型能否作为 primary / draft / review / final |

---

## 4. 推荐 ModelCapabilityProfile

建议将模型画像扩展为：

```typescript
interface ModelCapabilityProfile {
  modelId: string;

  level: 0 | 1 | 2 | 3;

  modalities: {
    text: boolean;
    image: boolean;
    audio: boolean;
    video: boolean;
    file: boolean;
  };

  skills: {
    code: boolean;
    architecture: boolean;
    toolCalling: boolean;
    jsonMode: boolean;
    longContext: boolean;

    ocr: boolean;
    uiScreenshot: boolean;
    chartUnderstanding: boolean;
    diagramUnderstanding: boolean;
    spatialReasoning: boolean;

    imageGeneration: boolean;
    imageEditing: boolean;
  };

  limits: {
    maxInputTokens?: number;
    maxOutputTokens?: number;
    maxImages?: number;
    maxImageSizeMB?: number;
    maxFileSizeMB?: number;
  };

  quality: {
    reasoningScore?: number;
    codeScore?: number;
    visionScore?: number;
    ocrScore?: number;
    uiScore?: number;
    chartScore?: number;
    diagramScore?: number;
  };

  privacy: {
    local: boolean;
    remote: boolean;
    allowSensitive: boolean;
  };

  cost: {
    relativeCost: "low" | "medium" | "high";
  };

  roles: Array<"primary" | "draft" | "review" | "final">;
}
```

---

## 5. routerProfile 示例

### 5.1 纯文本代码模型

```json
{
  "defaultLevel": 3,
  "relativeCost": "medium",
  "canDraft": true,
  "canReview": true,
  "allowedRoles": ["primary", "draft", "review", "final"],
  "capabilities": {
    "text": true,
    "code": true,
    "architecture": true,
    "toolCalling": true,
    "jsonMode": true,
    "longContext": true,

    "image": false,
    "ocr": false,
    "uiScreenshot": false,
    "diagramUnderstanding": false,
    "imageGeneration": false
  }
}
```

适合：

```text
代码修改
架构分析
计划审查
技术问答
Agent 系统设计
```

不适合：

```text
图片理解
UI 截图分析
架构图识别
OCR
```

---

### 5.2 多模态视觉模型

```json
{
  "defaultLevel": 3,
  "relativeCost": "high",
  "canDraft": true,
  "canReview": true,
  "allowedRoles": ["primary", "review", "final"],
  "capabilities": {
    "text": true,
    "code": true,
    "architecture": true,
    "toolCalling": true,
    "jsonMode": true,

    "image": true,
    "ocr": true,
    "uiScreenshot": true,
    "chartUnderstanding": true,
    "diagramUnderstanding": true,
    "spatialReasoning": true,

    "imageGeneration": false,
    "imageEditing": false
  }
}
```

适合：

```text
UI 截图分析
报错截图识别
架构图分析
图表理解
图片中的代码 / 文本识别
```

---

### 5.3 图片生成模型

```json
{
  "defaultLevel": 2,
  "relativeCost": "high",
  "allowedRoles": ["final"],
  "capabilities": {
    "text": true,
    "image": false,
    "imageGeneration": true,
    "imageEditing": true,
    "ocr": false,
    "uiScreenshot": false,
    "code": false
  }
}
```

适合：

```text
生成图片
编辑图片
风格转换
```

不适合：

```text
理解项目代码
架构分析
工具调用
复杂 Agent 执行
```

---

## 6. 图片能力需要细分

不要只写：

```text
vision: true
```

因为“能看图”不是单一能力。

建议拆成：

| 能力 | 含义 |
|---|---|
| `image` | 能接收图片输入 |
| `ocr` | 能识别图片中的文字 |
| `uiScreenshot` | 能分析 UI 截图、按钮、布局、状态 |
| `diagramUnderstanding` | 能理解架构图、流程图、关系图 |
| `chartUnderstanding` | 能读图表、坐标轴、趋势 |
| `imageDetail` | 能识别图片细节 |
| `spatialReasoning` | 能理解位置、区域、布局 |
| `imageGeneration` | 能生成图片 |
| `imageEditing` | 能编辑已有图片 |

原因：

```text
有的模型能读截图文字，但不擅长图表
有的模型能看 UI，但 OCR 不稳定
有的模型能生成图片，但不能理解图片
有的模型能看图，但不适合代码架构推理
```

---

## 7. 任务需求也要结构化

路由器不能只判断：

```text
任务需要 Level 3
```

而应该生成：

```typescript
interface TaskRequirement {
  minLevel: 0 | 1 | 2 | 3;
  requiredCapabilities: string[];
  preferredCapabilities?: string[];
  privacy?: {
    sensitive: boolean;
    allowRemote?: boolean;
  };
  role?: "primary" | "draft" | "review" | "final";
}
```

---

## 8. 不同任务的需求示例

### 8.1 纯代码架构分析

```json
{
  "minLevel": 3,
  "requiredCapabilities": ["text", "code", "architecture"],
  "preferredCapabilities": ["longContext", "jsonMode"]
}
```

---

### 8.2 UI 截图分析

用户上传截图并问：

```text
这个 UI 为什么显示不对？
```

任务需求：

```json
{
  "minLevel": 2,
  "requiredCapabilities": ["image", "uiScreenshot"],
  "preferredCapabilities": ["ocr", "spatialReasoning"]
}
```

---

### 8.3 图片里的报错截图

用户上传终端报错截图：

```json
{
  "minLevel": 2,
  "requiredCapabilities": ["image", "ocr"],
  "preferredCapabilities": ["code"]
}
```

---

### 8.4 架构图分析

用户上传流程图 / 架构图：

```json
{
  "minLevel": 3,
  "requiredCapabilities": ["image", "diagramUnderstanding", "architecture"],
  "preferredCapabilities": ["spatialReasoning"]
}
```

---

### 8.5 图表分析

用户上传图表：

```json
{
  "minLevel": 2,
  "requiredCapabilities": ["image", "chartUnderstanding"],
  "preferredCapabilities": ["ocr"]
}
```

---

### 8.6 生成图片

用户要求生成图片：

```json
{
  "minLevel": 1,
  "requiredCapabilities": ["imageGeneration"]
}
```

---

### 8.7 编辑图片

用户要求修改图片：

```json
{
  "minLevel": 1,
  "requiredCapabilities": ["imageEditing"]
}
```

---

## 9. 路由流程建议

模型路由应按以下顺序：

```text
1. 识别任务需求
2. 生成 TaskRequirement
3. 过滤不满足 requiredCapabilities 的模型
4. 过滤不满足 privacy policy 的模型
5. 过滤不满足 role 的模型
6. 按 level / quality / cost / latency 排序
7. 选择模型
8. 如果无模型可用，返回明确失败原因
```

伪流程：

```typescript
function routeModel(task: TaskRequirement, models: ModelCapabilityProfile[]) {
  return models
    .filter(m => m.level >= task.minLevel)
    .filter(m => supportsRequiredCapabilities(m, task.requiredCapabilities))
    .filter(m => satisfiesPrivacy(m, task.privacy))
    .filter(m => supportsRole(m, task.role))
    .sort(compareByQualityCostLatency);
}
```

---

## 10. 能力匹配失败时的提示

如果用户上传图片，但没有可用 vision 模型，不应该报：

```text
没有 Level 3 模型
```

而应该报：

```text
当前没有可用的图像理解模型。
该任务需要 capabilities.image=true 和 capabilities.uiScreenshot=true。

可选操作：
1. 显式选择支持图片的模型
2. 启用远程多模态模型
3. 将图片内容转成文字后继续
```

如果是隐私策略限制：

```text
当前任务包含图片输入，但支持图片的模型是远程模型。
由于 sensitive=true，远程模型被隐私策略排除。

可选操作：
1. 使用本地多模态模型
2. 显式允许该图片发送到远程模型
3. 手动描述图片内容后继续
```

这样用户能知道失败原因是：

```text
缺少图片能力
```

而不是：

```text
模型等级不够
```

---

## 11. declaredCapabilities 与 measuredCapabilities

仅靠配置声明还不够。

建议区分：

```text
declaredCapabilities：模型声称支持什么
measuredCapabilities：项目实测做得如何
```

例如：

```json
{
  "declaredCapabilities": {
    "image": true,
    "ocr": true,
    "uiScreenshot": true
  },
  "measuredCapabilities": {
    "ocrAccuracy": 0.92,
    "uiScreenshotScore": 0.86,
    "chartUnderstandingScore": 0.78,
    "diagramUnderstandingScore": 0.81
  }
}
```

含义：

```text
capabilities.image = true
→ 它支持图片输入

uiScreenshotScore = 0.86
→ 它实际分析 UI 的质量较好
```

---

## 12. 多模态能力评测建议

为了判断模型是否真的能正确识别图片，可以建立小型评测集：

| 评测类型 | 样例 |
|---|---|
| OCR | 截图中读取报错文字 |
| UI Screenshot | 判断按钮、输入框、面板状态 |
| Code Screenshot | 识别截图中的代码错误 |
| Diagram | 解释流程图节点关系 |
| Chart | 读取图表趋势和数值 |
| Spatial | 判断元素相对位置 |
| Mixed | 图片 + 代码文件结合分析 |

每次测试记录：

```text
模型
输入类型
任务类型
是否答对
结构化评分
人工评分
失败原因
```

---

## 13. 路由评分建议

当多个模型都满足 requiredCapabilities 时，可以按评分选择：

```text
score =
  levelWeight
+ capabilityQuality
+ roleFit
- relativeCost
- latencyPenalty
- privacyPenalty
```

例如 UI 截图任务：

```text
uiScore 权重大于 codeScore
```

架构设计任务：

```text
architectureScore / reasoningScore 权重大于 visionScore
```

报错截图任务：

```text
ocrScore + codeScore 都重要
```

---

## 14. 与 sensitive / privacy 的关系

多模态能力和隐私策略仍然要分开。

例如：

```text
模型支持图片
```

不代表：

```text
该图片可以发送给它
```

如果图片可能包含：

```text
源码
密钥
客户数据
用户隐私
内部系统截图
```

则需要判断：

```text
sensitive=true
```

路由时必须过滤：

```text
remote 模型
```

除非用户显式允许。

推荐字段：

```json
{
  "privacy": {
    "local": false,
    "remote": true,
    "allowSensitive": false
  }
}
```

路由规则：

```text
任务 sensitive=true
→ 只能选 local 或 allowSensitive=true 的模型
```

---

## 15. 与现有 Level 路由兼容

不要废弃 Level。

Level 仍然有用：

```text
判断复杂度
判断是否能做架构设计
判断是否能承担代码修改
判断是否能做 review/final
```

但 Level 只负责：

```text
强不强
```

Capability 负责：

```text
会不会
```

因此原有配置可以平滑升级：

```json
{
  "routerProfile": {
    "defaultLevel": 3,
    "relativeCost": "medium",
    "canDraft": true,
    "canReview": true,
    "allowedRoles": ["primary", "draft", "review", "final"],
    "capabilities": {
      "text": true,
      "code": true,
      "architecture": true,
      "image": false
    }
  }
}
```

---

## 16. 推荐 TodoList

## P0：模型能力画像

- [ ] 扩展 `routerProfile.capabilities`
- [ ] 增加 `modalities`
- [ ] 增加 `skills`
- [ ] 增加 `limits`
- [ ] 增加 `privacy`
- [ ] 增加 `roles`
- [ ] 为现有模型补 profile：
  - [ ] 本地文本模型
  - [ ] cloud-deepseek
  - [ ] 多模态模型
  - [ ] 图片生成模型

---

## P0：任务需求抽取

- [ ] 新增 `TaskRequirement`
- [ ] 从用户输入判断：
  - [ ] 是否有图片输入
  - [ ] 是否需要 OCR
  - [ ] 是否是 UI 截图
  - [ ] 是否是架构图
  - [ ] 是否是图表
  - [ ] 是否是图片生成
  - [ ] 是否是图片编辑
- [ ] 任务需求输出：
  - [ ] `minLevel`
  - [ ] `requiredCapabilities`
  - [ ] `preferredCapabilities`
  - [ ] `privacy`
  - [ ] `role`

---

## P0：路由器能力过滤

- [ ] 路由时先过滤 `requiredCapabilities`
- [ ] 再过滤 privacy policy
- [ ] 再过滤 role
- [ ] 再按 level / quality / cost 排序
- [ ] 路由失败时返回结构化原因：
  - [ ] `level_too_low`
  - [ ] `missing_capability`
  - [ ] `privacy_blocked`
  - [ ] `role_not_allowed`
  - [ ] `provider_unavailable`

---

## P1：多模态评测

- [ ] 建立小型评测集
- [ ] OCR 测试
- [ ] UI screenshot 测试
- [ ] Diagram 测试
- [ ] Chart 测试
- [ ] Code screenshot 测试
- [ ] 记录 measuredCapabilities
- [ ] 路由时使用 measured score 排序

---

## P1：UI / Debug 展示

- [ ] 模型详情展示：
  - [ ] Level
  - [ ] Capabilities
  - [ ] Privacy
  - [ ] Cost
  - [ ] Roles
- [ ] 路由日志展示：
  - [ ] 为什么选中某模型
  - [ ] 为什么排除某模型
  - [ ] 缺少什么能力
- [ ] 任务需求展示：
  - [ ] requiredCapabilities
  - [ ] preferredCapabilities
  - [ ] sensitive

---

## P2：高级能力

- [ ] 支持多模型协作：
  - [ ] vision model 读取图片
  - [ ] code model 修改代码
  - [ ] review model 审查方案
- [ ] 支持 OCR fallback：
  - [ ] 若无 vision 模型，可尝试本地 OCR 工具
- [ ] 支持图片转结构化 context：
  - [ ] 图片 → OCR / UI description → 文本模型继续处理

---

## 17. 最终目标

最终模型路由应支持：

```text
文本任务选文本/代码模型
图片任务选视觉模型
UI 截图选 uiScreenshot 能力强的模型
架构图选 diagramUnderstanding + architecture 模型
图片生成选 imageGeneration 模型
敏感图片只走本地或显式授权远程
```

一句话总结：

> **Level 只表示模型强不强；Capability 表示模型会不会。多模态路由必须基于 CapabilityProfile 和实际评测，而不是只看 ModelLevel。**
