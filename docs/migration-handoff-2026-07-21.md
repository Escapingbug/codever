# Codever 机器迁移与会话重建交接

> 用途：迁移到另一台机器、压缩上下文或重建 Codex 会话后，快速恢复正确的项目状态与产品方向。
>
> 日期：2026-07-21

## 1. 必须先确认的仓库位置

`D:\codever` 当前是旧主线：

```text
path: D:\codever
branch: master
HEAD: cc5613b
```

独立客户端、Matrix、Gateway和业务 E2E的当前实现位于：

```text
path: D:\codever-worktrees\matrix-cose-security
branch: feature/matrix-cose-security
document baseline HEAD: 268d917
```

不要在 `D:\codever` 的 `master` 上继续下一阶段客户端重构。迁移后应先恢复 `feature/matrix-cose-security`，再从目标提交创建新的独立 worktree。

本次文档位于：

```text
path: D:\codever-worktrees\product-task-chat-design
branch: docs/product-task-chat-design
base: feature/matrix-cose-security @ 268d917
```

规范性设计见 [`product-design-next.md`](./product-design-next.md)。

## 2. 当前实现形态

`feature/matrix-cose-security` 已包含：

- Vue/Tauri Web客户端及 Android/Windows打包。
- Matrix E2EE同步与原生 Rust transport。
- 客户端和 Gateway之间的 COSE执行授权。
- Gateway Project、Session、事件日志、附件和工具输出存储。
- Provider原生 Session discovery/attach。
- 缓存优先 Session历史、渐进加载和 optimistic message。
- ACP replay、Gateway journey、Playwright、Windows native等测试层。

关键目录：

```text
apps/web/                         Vue/Tauri客户端
packages/protocol/                客户端/Gateway共享协议
packages/execution-auth/          COSE执行授权
crates/matrix-transport/          Matrix原生 transport
src/gateway/                      Gateway应用、Project、Session和存储
src/providers/                    Codex/OpenCode等 Provider
e2e/                              Gateway/Matrix/ACP业务旅程
test/fixtures/acp/                可重放 ACP记录
docs/client-business-flows.md     当前业务测试契约
docs/business-capability-matrix.md 当前能力矩阵
```

## 3. 当前实现与目标设计的主要差距

当前协议仍然是：

```text
Gateway
  └─ Project (包含 gatewayId/rootPath)
       └─ CodeverSession
```

当前客户端路由也是：

```text
/projects/:gatewayId/:projectId/sessions/:sessionId
```

下一阶段必须改成：

```text
Project (全局逻辑对象)
  ├─ ProjectReplica (每台 Gateway上的副本)
  └─ Task
       └─ ExecutionSegment
            ├─ Workspace
            └─ ProviderSession
```

目标路由：

```text
/
/chats
/projects
/projects/:projectId
/tasks/:taskId
/settings/computers
/settings/plugins
```

## 4. 已确认且不要重新争论的产品决策

### Codever与 Codex App

- Codever目标是替代 Codex App，而不是与其长期交替控制同一个 Session。
- 支持从 Codex等 Provider已有会话一次性接续到 Codever。
- 接续外部 Session时保留其原 cwd；Codever不静默移动它。
- Codever新建的 Project Task默认使用独立 Git worktree。
- Android、PC等 Codever客户端操作同一个 Task、Gateway运行时和事件流。
- 切换 Codever客户端不等于切换执行 Computer。

### Project、Workspace和同步

- Project是全局逻辑对象，可以在多个 Gateway上存在 ProjectReplica。
- 每个 Codever新建的可写 Task拥有独立 Workspace。
- 无 Project Task使用 Codever托管的 scratch Git workspace。
- 跨 Gateway和跨 Project基于 Checkpoint/fork，不做活动目录双向同步。
- 不需要 Syncthing/Pijul作为核心机制。
- Revision使用现有 Git能力：临时 index、tree/commit、内部 ref、worktree和 bundle。

### 合并

- Codever不知道 Agent是否完成任务。
- `idle` 只表示 Agent当前没有回复，不表示完成。
- Codever不自动执行 merge或解决冲突。
- 用户点击“请求 Agent合并”后，Codever准备来源 revision、目标和提示词草稿。
- 用户自己点击发送，Agent实际检查、合并、处理冲突和测试。
- Agent回复后也不自动标记“合并成功”；是否接受由用户决定。

### Chat与插件

- Chat是与 Task并列的一级产品对象，用于讨论，不操作 Workspace。
- Chat Provider和 Agent Provider最终都通过插件接入。
- 首期只定义 Chat Plugin接口、capabilities、空状态和测试 Mock，不接入真实 ChatGPT/Claude/API。
- Chat中可选择单条、多条、整段或摘要，生成不可变 ContextSnapshot并创建 Task。
- Chat内容也可添加到已有 Task的 composer草稿。
- 生成的提示词不自动发送。
- **明确不实现 Task → Chat。**

### UI

- 一级导航：`首页 / 聊天 / Projects / 设置`。
- 首页以继续 Task和最近 Chat为主体，不以 Gateway为入口。
- Gateway面向用户称 Computer，放入设置管理。
- Project页面以 Task为主体，Computer只作为运行位置标签。
- 路径、revision、worktree和 Provider内部 ID默认隐藏。
- 缓存内容始终可打开；后台刷新不得锁住导航。
- 状态文案只陈述事实，不出现“任务完成”。

## 5. 明确排除项

- Task → Chat。
- Codever/Codex App双向 Session同步。
- 活动 Workspace持续双向文件同步。
- Codever自动判断任务完成。
- Codever自动合并和自动解决冲突。
- 首期真实 Chat Provider。
- 为旧协议长期保留兼容分支。

## 6. 数据权威设计

下一阶段按以下边界实现：

| 数据 | 权威来源 |
| --- | --- |
| Workspace、Provider进程和当前 turn | Gateway |
| Project目录、Replica映射、Task/Segment关系 | Matrix E2EE Codever目录事件 |
| Task语义事件 | Gateway日志，Matrix分发 |
| 外部 Chat历史 | Chat Plugin/外部服务 |
| Chat → Task ContextSnapshot | Codever加密持久化 |
| UI状态 | 本地缓存投影 |

Project不再属于 Gateway；Gateway库存只说明某个 Replica是否可用。

## 7. 下一阶段实施顺序

严格按以下顺序推进，不先堆 UI：

1. 将新用户旅程写入业务 E2E矩阵和测试骨架。
2. 破坏性升级 protocol：ProjectReplica、Task、ExecutionSegment、Workspace、ContextSnapshot、PluginDescriptor。
3. 实现 Gateway Git Workspace/Checkpoint/bundle。
4. 将现有 Agent Provider包装为插件契约；建立 Chat接口与 Scripted Mock。
5. 重构客户端路由、一级导航、规范化状态和缓存 schema。
6. 实现新建、Provider接续、临时 Task、并行副本、跨 Computer接续和提示词式合并。
7. 实现 Chat空状态和 Mock驱动的 Chat → Task。
8. 完成故障、多客户端、Windows和 Android发布门禁。

详细阶段、完成标准和测试旅程见 [`product-design-next.md`](./product-design-next.md)。

## 8. 迁移前必须处理的并行修改

在创建本文档 worktree时，目标实现 worktree存在未提交修改。迁移前必须重新运行：

```powershell
git -C D:\codever-worktrees\matrix-cose-security status --short
git -C D:\codever-worktrees\matrix-cose-security diff --stat
git worktree list --porcelain
```

当时观察到的修改是：

```text
M  apps/web/src-tauri/src/lib.rs
M  apps/web/src/api/matrixGatewayClient.ts
M  apps/web/src/state/codeverState.ts
M  apps/web/tests/matrixGatewayClient.test.ts
?? apps/web/tests/gatewayDiscoveryCache.test.ts
```

这些修改属于其他并行工作，本文档分支没有包含它们。不要通过 reset、checkout或删除来清理；应由对应 Agent提交，然后在新实现 worktree中显式合入。

## 9. 新机器恢复步骤

1. 复制或重新 clone完整 Git repository，包括所有需要保留的分支。
2. 确认 `feature/matrix-cose-security`、文档分支和并行 Agent提交均存在。
3. 安装 Node 20+、pnpm 11.5.2、Rust/Tauri、Android SDK和 Git。
4. 先阅读本文及 [`product-design-next.md`](./product-design-next.md)。
5. 在目标磁盘创建新的实现 worktree，不直接在 `master`工作。
6. 运行基线检查：

```powershell
pnpm install
pnpm typecheck:all
pnpm test:business-e2e
```

7. 若迁移后重新部署 Matrix/Gateway，先确认现有凭据和私有数据的迁移策略，不把密码或 token提交到 Git。
8. 从 Phase 0的 E2E契约开始，不直接进入页面重写。

## 10. 新会话启动提示词

迁移后可将下面内容作为新 Codex会话的初始要求：

```text
请先完整阅读 AGENTS.md、docs/migration-handoff-2026-07-21.md 和
docs/product-design-next.md。当前目标是按文档实现 Codever 下一阶段产品模型。

必须遵守：
1. Codever替代 Codex App，只单向接续外部 Provider Session。
2. Codever客户端共享同一个 Task；新 Task默认独立 worktree。
3. Project是全局对象，Gateway上的是 ProjectReplica。
4. 跨 Gateway/Project使用 Checkpoint和 fork，不做实时目录同步。
5. 合并只生成用户确认发送的 Agent提示词，不自动 merge。
6. Chat首期只建立插件接口、空 UI和 Mock；支持 Chat → Task，不做 Task → Chat。
7. 先补业务 E2E契约，再修改协议和实现。
8. 所有修改必须在独立 worktree；未经确认不得合并。

开始前检查目标分支和所有现有 worktree/未提交修改，报告任何冲突或缺失。
```
