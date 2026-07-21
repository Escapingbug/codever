# Codever 下一阶段产品与架构设计

> 状态：下一阶段规范性设计（implementation target）
>
> 更新时间：2026-07-21
>
> 实现基线：`feature/matrix-cose-security` at `268d917`

本文固定下一阶段 Codever 的产品边界、用户心智模型、UI 信息架构、核心业务场景、领域模型、插件边界和实现顺序。后续实现若与本文冲突，应先修改本文并重新确认设计，而不是在代码中形成第二套隐含业务逻辑。

## 1. 产品定位

Codever 是一个多端、远程优先、可扩展的聊天与 coding-agent 客户端。它承担两类不同工作：

- **Chat**：讨论、分析和形成任务上下文，不操作项目工作区。
- **Task**：让 Agent 在明确的 Workspace 中执行开发工作。

Codever 的目标是替代 Codex App 一类 coding-agent 客户端，而不是长期与其交替控制同一个 Provider Session。Codever可以从 Codex、OpenCode 等 Provider 已有会话中接续；接续之后，后续交互应主要发生在 Codever 的 Android、PC 和其他客户端之间。

```text
外部 Provider 会话
        │ 一次性接续/接管
        ▼
Codever Task ── 同一事件流 ── Android / PC / future clients
        │
        ▼
Gateway + Provider Session + Workspace
```

Codever客户端之间切换时，不迁移工作目录、不建立新 Provider Session，也不复制代码。它们只是同一个 Task 的不同视图。只有用户显式选择“在另一台 Computer 上继续执行”时，才发生 Workspace Checkpoint 和新的执行阶段。

## 2. 用户心智模型与术语

用户只需要理解以下一级概念：

| 概念 | 用户理解 | 不应默认暴露的内部细节 |
| --- | --- | --- |
| Chat | 与某个聊天服务讨论问题 | API endpoint、外部 conversation ID |
| Task | 让 Agent 实际执行一项工作 | Provider session ID、ACP event |
| Project | 组织同一代码项目的 Task | Git common dir、内部 project ref |
| Workspace | 一个 Task 实际修改文件的位置 | worktree path、detached HEAD |
| Computer | 运行 Task 的机器 | Gateway ID、Matrix room |
| Plugin | 接入聊天或 Agent 服务 | 进程位置、RPC transport |

内部实现使用以下对应关系：

```text
Project
  ├─ ProjectReplica (Project 在某台 Gateway 上的可用副本)
  └─ Task
       └─ ExecutionSegment
            ├─ Workspace
            └─ ProviderSession
```

Task 是用户持续理解的工作；ExecutionSegment 是 Task 在某台 Computer 上的一段实际执行。当 Task 转移到另一台 Computer 时，Task ID 和用户历史保持连续，但会创建新的 Workspace 和 Provider Session。

## 3. 明确的产品边界

### 3.1 支持的方向

- 外部 Provider Session → Codever Task。
- Chat 中选定内容 → 新 Task。
- Chat 中选定内容 → 已有 Task 的待发送提示词。
- Task → 新的并行 Task。
- Task → 另一台 Computer 上的新执行阶段。
- Task Workspace → Checkpoint → 另一个 Project/Replica 的 fork。
- Task 的修改 → 由 Agent执行的提示词式合并。

### 3.2 明确不做

- 不支持 Codever 与 Codex App 长期交替控制同一个 Provider Session。
- 不承诺 Codever创建的 Session 在 Codex App 中按相同 Project 分组。
- 不设计 Task → Chat。
- 不设计活动工作目录的持续双向文件同步。
- 不使用 Syncthing、Pijul 或自研同步协议作为并发开发基础。
- 不由 Codever判断“任务已完成”。
- 不由 Codever自动决定如何合并或解决冲突。
- 不自动发送由 Chat、fork、handoff 或 merge 生成的提示词。
- Chat 首期不接入真实服务，只定义插件接口、占位 UI 和确定性测试 Mock。

## 4. 一级导航与信息架构

移动端和 PC 共享同一信息架构，布局可响应式变化。

```text
首页 | 聊天 | Projects | 设置
```

### 4.1 首页

首页优先回答“我接下来要继续什么”，而不是展示基础设施。

```text
继续工作
  修复 Session 重连问题
  Codever · Codex · 正在回复

最近聊天
  Codever 新架构讨论
  Chat Provider · 10 分钟前

Projects
  Codever
  My Website

                              ＋
```

全局创建菜单：

```text
新建聊天
新建 Task
新建临时 Task
新建 Project
从 Provider 接续
```

### 4.2 聊天

聊天页按插件提供统一列表；插件能力决定是否支持服务端历史、发送、附件、分支等操作。

首期没有真实 Chat Plugin 时显示：

```text
聊天

尚未连接聊天插件
安装或配置聊天插件后，可以在这里浏览聊天，并将选定内容转换为 Task。

[管理插件]
```

不得用假的 ChatGPT 数据伪装为真实功能。测试和开发环境可注入明确标记的 Mock Chat Plugin。

### 4.3 Projects

Project 是全局逻辑对象，不再从属于某一 Gateway。Project 页面以 Task 为主体，Computer只作为运行位置标签。

```text
Codever

正在使用
  实现 Task 独立 worktree
  Windows · Codex · 正在回复

  修复 Session 重连
  Linux · Codex · 空闲

最近
  Matrix 协议调研

相关聊天
  Codever 新架构讨论

[新建 Task] [从 Provider 接续]
```

Project路径、Replica、revision 和完整 Provider元数据默认隐藏在详情中。

### 4.4 设置

```text
设置
  Computers
  Plugins
    Chat Providers
    Agent Providers
  Matrix 与同步
  存储
  安全
```

Gateway 是内部概念。面向用户统一称为 Computer。Computer管理不应成为进入 Project 或打开缓存 Task 的前置页面。

## 5. 完整用户场景

### 5.1 从原生 Codex 接续

用户曾在 `D:\codever` 中直接启动 Codex。Codever在 Project 中提供“从 Provider 接续”，列出 Provider 原生会话。

用户选择后：

1. Codever记录 Provider Session ID、原 cwd 和历史。
2. Gateway恢复原 Provider Session。
3. 创建 Codever Task 与该 Session 的关联。
4. Workspace仍为 `D:\codever`，不静默移动。
5. UI 标记“项目主目录”，提醒它可能被外部工具同时修改。

接续后建议只通过 Codever继续。若检测到该 Session 在 Codever外继续过，应提示“外部状态发生变化”，允许重新导入为新 Task；不得静默假装两侧完全同步。

### 5.2 在 Codever 中新建 Project Task

用户进入 Project，点击“新建 Task”：

1. 选择“开始新任务”。
2. 只有存在多个可用位置时才选择 Computer；否则使用 Project首选 Replica。
3. 加载该 Computer 的 Agent Plugin 和动态能力。
4. 创建独立 Git worktree。
5. 创建 Provider Session。
6. 打开 Task，用户输入并发送首条要求。

Codever新建的每个可写 Task 默认拥有独立 Workspace。多个 Task 可以属于同一个 Project，但不共享可变目录。

### 5.3 多个 Codever 客户端交替使用

Task 在 Windows Gateway 上运行时，Android 和 PC 打开的是同一个 Task：

- 两端共享同一用户消息、Agent输出、工具状态和决策请求。
- 用户消息先乐观显示，再与 Gateway权威事件按 `clientMessageId` 对账。
- Gateway按 Task串行执行 turn，并用 `commandId` 保证重试只执行一次。
- 任一客户端 Stop 的是同一个当前 turn。
- 客户端切换不改变执行 Computer。
- 离线客户端先显示缓存，恢复后按事件 cursor 追赶。

若 Agent正在执行而另一客户端发送新消息，UI 应提供“等待当前回复后发送”“停止并发送”“取消”，而不是建立第二个并发 turn。

### 5.4 新建临时 Task

用户无需先创建 Project：

1. 点击“新建临时 Task”。
2. 选择 Computer 和 Agent。
3. Codever创建托管目录和内部 Git repository。
4. Task正常支持消息、文件、Checkpoint 和跨 Computer接续。
5. 后续可“保存为 Project”，保留原 Task、Workspace和历史。

临时 Task有 `temporary`、`pinned`、`project` 生命周期。包含未导出修改的 Workspace不得被静默清理。

### 5.5 创建并行副本

用户在一个 Task 中选择“创建并行副本”：

1. Codever对来源 Workspace生成 Checkpoint。
2. 从该 Checkpoint创建新的独立 Workspace。
3. 创建新的 Task和 Provider Session。
4. 原 Task继续保留和运行。

两个 Task从同一代码版本开始，后续完全独立，不做实时同步。

### 5.6 在另一台 Computer 上继续

用户显式选择“在另一台 Computer 上继续执行”：

1. 等待当前 turn结束或由用户明确中断。
2. 保存 Workspace Checkpoint。
3. 通过 Git bundle 和现有 E2EE媒体通道传输缺失 Git对象。
4. 在目标 ProjectReplica中创建新 worktree。
5. 建立新的 Provider Session与 ExecutionSegment。
6. 生成接续提示词草稿，包含任务目标、重要上下文和来源 revision。
7. 用户检查并点击发送。

原 ExecutionSegment保留历史，默认暂停继续写入。若用户需要两边并行，应使用“创建并行副本”。

### 5.7 从 Project 创建新 Project

跨 Project操作是 fork，不是同步：

1. 用户选择来源 Task/Workspace的 Checkpoint。
2. 输入新 Project名称和目标 Computer。
3. Codever创建新 Project ID、ProjectReplica和 Workspace。
4. 新 Project记录 `forkedFromProjectId` 和来源 revision。
5. 两个 Project此后独立演进。

### 5.8 请求 Agent 合并

Codever不知道任务是否完成，也不自动执行 merge。用户认为来源修改值得合并时，在来源 Task 中选择“请求 Agent 合并”：

1. 用户选择目标 Task、目标 Project主工作区，或创建专用合并 Task。
2. Codever保存来源 Checkpoint。
3. 若跨 Gateway，则将来源 Git对象传到目标 Replica并注册内部 ref。
4. 打开目标 Task。
5. 在输入框生成明确提示词，但不自动发送。
6. 用户可补充范围后点击发送。
7. Agent负责检查差异、执行合并、解决冲突和运行测试。

示例提示词：

```text
请将“设置页面重构”来源版本中的修改合并到当前工作区。
先检查差异，保留当前工作区已有有效修改；如有冲突，请结合两个任务的目标处理。
合并后运行相关检查，并说明修改、冲突、验证和仍需我决定的问题。
不要推送远程仓库，不要删除来源工作区。
```

Agent回复结束后，Codever只能显示“Agent空闲”“工作区有修改”等事实状态。是否接受由用户决定。

### 5.9 Chat 浏览与新建

未来 Chat Plugin 可以提供外部历史或 Codever托管历史。统一 Chat UI 根据能力显示：

- 列出/加载聊天。
- 新建和发送。
- 流式响应。
- 附件。
- 编辑、重新生成和分支（可选）。

首期只完成插件能力描述、空状态和 Mock测试，不实现真实 API、账号登录或历史同步。

### 5.10 Chat → 新 Task

用户在 Chat 中长按单条消息或多选消息，然后选择“创建 Task”：

1. Codever建立不可变 `ContextSnapshot`。
2. 用户选择现有 Project、新 Project或临时 Task。
3. 选择 Computer和 Agent。
4. UI展示将发送的消息、附件、目标 Computer和 Agent。
5. Codever创建 Task和 Workspace。
6. 在 Task输入框生成提示词草稿。
7. 用户检查并点击发送。

上下文可以来自：单条消息、多条消息、截至当前位置的完整聊天，或可编辑摘要。默认不发送整段聊天。

### 5.11 Chat → 已有 Task

用户选择 Chat内容并点击“添加到已有 Task”：

1. 选择目标 Task。
2. Codever打开目标 Task。
3. 输入框中生成引用消息和操作要求。
4. 用户检查并发送。

原 Chat继续变化不会静默更新 Task。要补充后续内容必须再次显式引用。

### 5.12 Task → Chat

不实现。Task消息没有“在聊天中讨论”入口，插件接口也不为该方向保留业务命令。

## 6. 事实状态模型

Codever不得用 Provider的一轮结束推断业务完成。

### 6.1 Task运行状态

```text
idle
responding
waiting_for_decision
canceling
offline
error
archived
```

用户文案对应“空闲”“正在回复”“等待你的决定”“正在停止”“Computer离线”“需要处理”“已归档”。不使用 `completed` 或 `successfully_merged`。

### 6.2 Workspace事实状态

```text
clean
modified
checkpointing
checkpointed
transferring
unavailable
```

这些只说明文件和传输状态，不说明需求是否完成。

## 7. 领域模型

### 7.1 Project 与 Replica

当前协议的 `Project.gatewayId` 必须拆分：

```ts
interface Project {
  id: string
  name: string
  repoIdentity?: string
  defaultAgentPluginId?: string
  forkedFromProjectId?: string
  archivedAt?: string
}

interface ProjectReplica {
  id: string
  projectId: string
  gatewayId: string
  rootPath: string
  platform: 'windows' | 'macos' | 'linux' | 'container' | 'unknown'
  status: 'ready' | 'preparing' | 'offline' | 'error'
  headRevision?: string
}
```

Project定义和 Replica映射作为加密 Codever目录事件在 Matrix个人控制空间中同步；Gateway库存是 Replica可用性的事实来源；客户端缓存只是投影。

### 7.2 Task、ExecutionSegment 与 Workspace

```ts
interface Task {
  id: string
  projectId?: string
  title?: string
  currentSegmentId: string
  sourceContextIds: string[]
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

interface ExecutionSegment {
  id: string
  taskId: string
  gatewayId: string
  replicaId?: string
  workspaceId: string
  agentPluginId: string
  providerSessionId?: string
  predecessorSegmentId?: string
  state: TaskRuntimeState
}

interface Workspace {
  id: string
  kind: 'primary_checkout' | 'managed_worktree' | 'scratch'
  path: string
  baseRevision?: string
  headRevision?: string
  checkpointRef?: string
}
```

外部接续 Session使用 `primary_checkout`；Codever新建 Project Task使用 `managed_worktree`；无 Project Task使用 `scratch`。

### 7.3 Chat 与 ContextSnapshot

```ts
interface ChatDescriptor {
  id: string
  pluginId: string
  externalConversationId?: string
  title: string
  updatedAt: string
}

interface ContextSnapshot {
  id: string
  source: 'chat'
  pluginId: string
  conversationId: string
  conversationTitle?: string
  capturedAt: string
  messages: ContextMessage[]
  attachments: ContextAttachment[]
  renderedText: string
}
```

ContextSnapshot是不可变快照，不是外部聊天的实时指针。Task必须在外部聊天删除、插件离线或消息变化后仍能解释自己收到过什么上下文。

## 8. Git Workspace 与 Revision 实现

不自研版本格式，使用系统 Git CLI：

| Codever操作 | Git能力 |
| --- | --- |
| Checkpoint | 临时 `GIT_INDEX_FILE` + `write-tree` + `commit-tree` |
| 内部指针 | `refs/codever/...` |
| 独立 Workspace | `git worktree add --detach` |
| 跨 Gateway传输 | `git bundle create/verify/fetch` |
| 差异展示 | `git diff` |
| Agent合并来源 | 目标仓库内部 ref |

Checkpoint不得修改用户 `HEAD`、当前分支或 staging area。默认包含 tracked文件和非 ignored新增文件；ignored文件、LFS对象、子模块内容和环境配置分别处理。敏感 ignored文件不得默认传输，可通过显式 `.codeverinclude` 策略加入。

Matrix只传输加密 bundle和控制事件，不理解 Git对象。Project跨 Gateway和跨 Project都基于不可变 revision按需传输，不维护活动目录的持续一致性。

## 9. 插件边界

UI和领域模型不得硬编码 `codex`、`chatgpt` 等产品名称。

### 9.1 通用描述

```ts
interface PluginDescriptor {
  id: string
  kind: 'chat' | 'agent'
  displayName: string
  version: string
  capabilities: string[]
  connectionState: 'available' | 'unconfigured' | 'offline' | 'error'
}
```

插件运行位置不是 UI 契约的一部分。UI只面向 `ChatProviderPort` 或 `AgentProviderPort`。未来插件可以运行在 Gateway、专用 Plugin Host或受控客户端环境中，传输适配器不得泄漏到视图层。

### 9.2 ChatProviderPort

首期只定义接口和 Mock：

```ts
interface ChatProviderPort {
  descriptor(): Promise<ChatPluginDescriptor>
  listConversations?(cursor?: string): Promise<ChatPage>
  loadConversation?(conversationId: string, cursor?: string): Promise<ChatMessagePage>
  createConversation?(input: CreateChatInput): Promise<ChatDescriptor>
  sendMessage?(conversationId: string, input: ChatMessageInput): AsyncIterable<ChatEvent>
}
```

能力至少细分为：

```text
list_conversations
load_history
create_conversation
send_message
stream_response
attachments
edit_message
regenerate
branch_conversation
```

### 9.3 AgentProviderPort

现有内建 Provider先通过适配器实现统一插件契约，动态第三方加载后续实现。能力至少包括：

```text
discover_sessions
resume_session
create_session
cancel_turn
models
reasoning_options
permission_modes
attachments
decisions
tools
```

模型、reasoning、fast、权限模式等控件必须等待能力加载完成后再显示；不支持的控件不出现，不能回退为任意文本输入。

## 10. 数据权威与多端同步

| 数据 | 权威来源 |
| --- | --- |
| Provider进程、当前 turn、Workspace | Gateway |
| Project目录、Replica关联、Task/Segment关系 | Matrix E2EE Codever目录事件 |
| Task语义事件 | Gateway事件日志，Matrix分发 |
| 外部 Chat历史 | Chat Plugin/外部服务；Codever缓存 |
| ContextSnapshot | Codever加密持久化 |
| 客户端展示 | 本地缓存投影，可离线读取 |

所有 mutation使用稳定 operation/request ID。客户端缓存和 Matrix重投必须按 ID/sequence收敛，不能依赖“请求没有超时”判断操作是否执行。

创建 Task但尚未发送的生成提示词应作为跨客户端可见的 Task Draft持久化，而不是只保存在某一客户端内存中。

## 11. 错误与加载体验

- 缓存 Project、Task和历史始终可打开，后台刷新不能成为导航锁。
- Chat Plugin不可用时，已缓存聊天仍可查看；创建和发送明确禁用并给出修复入口。
- 一个 Computer离线不等于整个 Project unavailable。
- 一个 Replica加载失败不隐藏其他 Replica上的 Task。
- 长操作展示具体阶段：保存、传输、准备 Workspace、启动 Agent。
- 重试从最后一个已确认阶段继续，且使用相同 operation ID。
- “Connected”必须说明连接层，不能与“Connection unavailable”并列制造冲突。
- 生成提示词失败不创建半完成的 Task；Workspace准备成功但首条消息未发送时保留为 Draft。

## 12. 测试契约

在实现代码前，先将以下旅程加入业务 E2E矩阵。每个旅程必须同时断言中间状态和最终状态，不允许只测试完全正常的最终结果。

### 12.1 核心 Task旅程

1. 从 Project创建独立 Workspace Task。
2. 从 Provider已有 Session接续，保留原 cwd。
3. Android发送、PC同步看到同一 optimistic message、stream和结果。
4. 两端重发同一 command只执行一次。
5. 缓存 Task在 inventory/provider discovery失败时仍可打开。
6. 新建临时 Task并保存为 Project。
7. 创建并行副本，两个 Workspace互不修改。
8. 跨 Computer接续在每个阶段断线并可恢复。
9. 请求 Agent合并只生成草稿，不自动发送或自动标记成功。
10. Agent idle时 UI不出现“完成”。

### 12.2 Chat插件与上下文旅程

1. 无 Chat Plugin的空状态与设置入口。
2. Mock Plugin声明不同 capabilities，UI只显示支持操作。
3. 浏览 Mock聊天并选择一条/多条消息。
4. Chat内容创建 Task，ContextSnapshot持久化且提示词不自动发送。
5. Chat内容添加到已有 Task，目标 composer生成草稿。
6. 原 Chat变化或 Plugin离线不改变已生成 ContextSnapshot。
7. UI不存在 Task → Chat操作。

### 12.3 平台门禁

- 协议 schema和破坏性版本测试。
- Gateway Workspace/Checkpoint/bundle集成测试。
- ACP replay业务旅程。
- Vue/Vitest状态与缓存测试。
- Playwright移动和桌面视口旅程及关键截图。
- Windows Tauri WebView2真实壳测试。
- Android安装、后台恢复、网络切换和真实设备纵向门禁。

## 13. 分阶段实现计划

### Phase 0：文档和 E2E先行

- 固定本文、术语和导航。
- 更新业务能力矩阵，先写失败的场景级测试骨架。
- 建立 UI Mock数据和可控 Provider/Chat replay gate。

完成标准：每项下一阶段能力都有唯一用户旅程 ID、状态断言和错误场景。

### Phase 1：破坏性领域与协议重构

- 引入 ProjectReplica、Task、ExecutionSegment、Workspace、ContextSnapshot和 PluginDescriptor。
- 从 Project路由和 schema中移除 Gateway归属。
- 升级协议版本，不保留旧 schema兼容分支。
- 旧开发数据使用显式 reset/重新注册，不写长期迁移负债。

完成标准：协议测试证明 Project全局、Task绑定 Segment、Replica绑定 Gateway。

### Phase 2：Gateway Workspace与 Revision

- 实现 Git仓库识别和 ProjectReplica注册。
- 实现 managed worktree和 scratch repository。
- 实现不污染用户 index的 Checkpoint。
- 实现 bundle创建、验证、导入和内部 ref。
- 将 Provider创建 cwd改为 Workspace路径。
- 外部 Provider接续保留原 cwd。

完成标准：两个并发 Task修改同一 Project不同 Workspace互不影响；中断后可从 Checkpoint重建。

### Phase 3：插件契约

- 新增共享 Plugin API包。
- 将现有 Agent Provider registry包装为 Agent Plugin adapter。
- 定义 Chat Plugin DTO、capabilities和 transport-neutral port。
- 提供仅测试/开发使用的 Scripted Chat Plugin。
- 不实现真实聊天账号、API或凭据管理。

完成标准：UI完全通过 descriptor/capabilities渲染，无 Provider名称分支。

### Phase 4：客户端信息架构和状态库

- 路由调整为 `/`, `/chats`, `/projects`, `/projects/:projectId`, `/tasks/:taskId`, `/settings/...`。
- Projects首页不再是 Gateway列表。
- 状态库改为规范化 `projectsById/replicasByProject/tasksByProject/segmentsByTask`。
- Computer管理移入设置。
- 升级本地缓存 schema并显式清理旧缓存。

完成标准：首页、Project和缓存 Task在 Gateway刷新失败时仍可导航。

### Phase 5：完整 Task UI

- 新建 Project Task。
- 从 Provider接续。
- 临时 Task和保存为 Project。
- 动态 Agent能力控件。
- 并行副本。
- 跨 Computer接续阶段 UI。
- 提示词式合并。
- 多客户端 Draft和同一 Task控制。

完成标准：核心 Task旅程在 replay、Playwright和Windows壳中通过。

### Phase 6：Chat占位与 Chat → Task

- Chat导航、插件空状态和设置入口。
- Mock Plugin驱动聊天列表、详情和消息选择 UI。
- ContextSnapshot预览、隐私确认和持久化。
- 创建新 Task或补充已有 Task的草稿流程。
- 明确不实现 Task → Chat。

完成标准：无真实聊天服务也能自动化验证插件接入和 Chat → Task完整 UI契约。

### Phase 7：跨 Gateway/Project fork和发布门禁

- 完成 Matrix目录事件与 Replica协调。
- 完成 bundle E2EE传输和断点恢复。
- 完成跨 Project fork。
- 扩充多客户端和故障 E2E。
- 执行 Windows、Android和真实 Matrix/Gateway纵向验证。

完成标准：基础故事线不依赖手工数据库、服务器操作或刷新页面才能完成。

## 14. 实施纪律

- 每个 Phase在独立 worktree和 feature branch完成。
- 不直接修改 `master`，不在未确认前合并。
- 并行 Agent按协议、Gateway、客户端、测试等不重叠边界拆分；写同一文件的任务串行处理。
- 每个生产问题先加入最高可行层级的回归旅程，再修复。
- 不为了“先跑起来”保留第二套旧业务模型；项目仍在起步阶段，破坏性设计变更直接升级协议和清理测试数据。
