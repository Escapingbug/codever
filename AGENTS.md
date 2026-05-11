<!-- architecture:start -->
# Architecture & Implementation Notes

Full design doc: `docs/architecture.md`

## Project Purpose

Codever is an **ACP to Channel bridge**. It connects ACP-compatible coding agents to messaging channels, currently Telegram, and exposes Codever-specific MCP tools/resources back to the running agent.

## Current Architecture

The active runtime shape is:

```text
Telegram update
  -> Telegram handlers
  -> SessionManager
  -> TopicSession
  -> SemanticSessionRuntime
  -> AgentProvider / ACP
  -> ProviderSemanticAdapter
  -> ConversationEvent
  -> ChannelProjector
  -> DeliveryOutbox
  -> TelegramPort
```

This is a **Telegram Topic Session Gateway with a Semantic Runtime**.

## Project Principles

- **意外错误优先于任务完成。** 在完成任务过程中如果出现任何意外错误——包括但不限于：模型调用失败、子代理调用失败/超时、执行环境问题、缺乏依赖、工具不存在——必须立即告知用户，不允许为了完成任务而默默绕过。可以将可行的绕过方案一并提供给用户选择，但必须先报告错误本身。
  - ❌ 错误示范：用户要求写入全局记忆，发现没有全局记忆机制后，不告知用户，直接写入本地文件当作"差不多"。
  - ❌ 错误示范：子代理超时被中断，不告知用户，默默换用其他工具继续推进任务。
  - ✅ 正确做法：先报告错误（"我没有全局记忆的写入能力"），再提出替代方案让用户选择（"我可以写入项目级 AGENTS.md，是否可以？"）。
- **Every change MUST be made in a git worktree.** Create a worktree on a feature branch before modifying any file. Never edit directly on `bridge`; direct edits to `master` are allowed only with explicit user approval.
- **Never merge without user approval.** After completing and testing changes in a worktree, present the diff and wait for explicit user confirmation before merging (cherry-pick, merge, or rebase) into the target branch.
- **Clean up after merge.** Once a worktree's changes are merged and confirmed, remove the worktree and delete the feature branch.

## Key Invariants

- **One Telegram topic maps to one active `TopicSession`.**
- **`SemanticSessionRuntime` is the execution core** for query, cancel, command, and finalize behavior.
- **Provider events are normalized before rendering**: `AgentEvent -> ConversationEvent -> ChannelMessage`.
- **`DeliveryOutbox` is the only send/edit reliability layer** for channel delivery.
- **`TelegramPort` owns Telegram API details** including send, edit, table rendering, chat actions, and decision UI.
- **`SessionManager` owns session lookup and persisted group/topic state.**
- **Scheduled and MCP-injected messages use the same runtime path as user messages.**
- **`SessionRecord` is metadata only.** Runtime behavior belongs in `SemanticSessionRuntime`.

## Component Map

```text
src/
  daemon.ts                         # composition root
  config.ts                         # persistent config and topic state

  bridge/
    channelPort.ts                  # ChannelPort and TopicSession interfaces
    sessionManager.ts               # session registry and persisted group/topic state
    topicSession.ts                 # topic -> SemanticSessionRuntime bridge

  runtime/
    semantic.ts                     # SessionInput and ConversationEvent model
    semanticSessionRuntime.ts       # active execution runtime
    providerAdapter.ts              # AgentEvent -> ConversationEvent
    channelProjector.ts             # ConversationEvent -> ChannelMessage
    deliveryOutbox.ts               # serialized send/edit delivery

  channel/telegram/
    bot.ts                          # bot factory
    telegramPort.ts                 # ChannelPort implementation
    pairing.ts                      # user pairing
    toolBubble.ts                   # tool bubble formatting
    keyboard.ts                     # inline keyboard builders
    renderer.ts                     # markdown/html Telegram renderer
    handlers/                       # active Telegram command/callback/message handlers

  providers/
    provider.ts                     # AgentProvider interface
    types.ts                        # AgentEvent model
    registry.ts                     # provider catalog and factories
    acp/                            # shared ACP provider implementation
    opencode/                       # opencode provider
    codebuddy/                      # codebuddy provider
    agent/                          # Cursor agent provider

  mcp/
    stdio.ts                        # active MCP stdio entry
    register.ts                     # shared MCP surface registration
    resources.ts                    # codever context resources/tools
    tools/                          # notify/session tools

  core/
    scheduler.ts                    # timed tasks
    eventBus.ts                     # session lifecycle events
```

## Maintenance Guidance

Preserve the semantic runtime architecture. New behavior should fit one of the existing ownership boundaries:

1. Runtime lifecycle and commands belong in `SemanticSessionRuntime`.
2. Session lookup and persisted topic/group state belong in `SessionManager` and `config.ts`.
3. Provider-specific event quirks belong in provider adapters.
4. Visible message shaping belongs in `ChannelProjector`.
5. Send/edit reliability belongs in `DeliveryOutbox`.
6. Telegram API details belong in `TelegramPort` and `channel/telegram/handlers`.

Provider-specific ACP extension methods must stay inside the owning provider. The shared ACP client may expose generic `extMethod`/`extNotification` hooks, but Cursor-specific `cursor/*` behavior belongs in `src/providers/agent/cursorExtensions.ts`, not in `runtime/providerAdapter.ts` or channel rendering code.

<!-- architecture:end -->
