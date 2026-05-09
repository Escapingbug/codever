<!-- architecture:start -->
# Architecture & Implementation Plan

Full design doc: `docs/architecture.md`

## Project Purpose

Codever is an **ACP ↔ Channel Bridge**. It connects ACP-compatible coding agents to messaging channels (currently Telegram), faithfully replicating the local TUI experience remotely. On top of this bridge, codever exposes itself as an MCP server to agents, enabling proactive messaging, self-awareness, and management.

## Architecture Layers

```
Channel Layer       — Telegram / Discord / CLI (replaceable, implements ChannelPort)
Bridge Layer        — SessionBridge (wiring) + SessionManager (lifecycle) + ChannelPort interface
Core Layer          — CoreSession state machine + EventBus + Scheduler (~600 LOC)
Middleware Layer    — Structure-aware Pipeline + Formatting + Timeout (dedup/content-limit inlined)
MCP Layer           — MCP server exposed to agent via ACP mcpServers param
Provider Layer      — AcpProvider base → OpencodeProvider / CodebuddyProvider
```

## Project Principles

- **意外错误优先于任务完成。** 在完成任务过程中如果出现任何意外错误——包括但不限于：模型调用失败、子代理调用失败/超时、执行环境问题、缺乏依赖、工具不存在——必须立即告知用户，不允许为了完成任务而默默绕过。可以将可行的绕过方案一并提供给用户选择，但必须先报告错误本身。
  - ❌ 错误示范：用户要求写入全局记忆，发现没有全局记忆机制后，不告知用户，直接写入本地文件当作"差不多"。
  - ❌ 错误示范：子代理超时被中断，不告知用户，默默换用其他工具继续推进任务。
  - ✅ 正确做法：先报告错误（"我没有全局记忆的写入能力"），再提出替代方案让用户选择（"我可以写入项目级 AGENTS.md，是否可以？"）。
- **Every change MUST be made in a git worktree.** Create a worktree on a feature branch before modifying any file. Never edit directly on `bridge` or `master`.
- **Never merge without user approval.** After completing and testing changes in a worktree, present the diff and wait for explicit user confirmation before merging (cherry-pick, merge, or rebase) into the target branch.
- **Clean up after merge.** Once a worktree's changes are merged and confirmed, remove the worktree and delete the feature branch.

## Key Invariants

- **Core never imports Channel, MCP, or Provider** — only interfaces and types
- **ChannelPort is the only channel abstraction** — Telegram/Discord/CLI each implement it
- **Pipeline flushes are structure-aware** — never split mid-table, mid-code-block, mid-list
- **Session state machine is the sole authority** for query lifecycle: `idle → querying → canceling → idle`
- **Provider switch = session recreation** — destroy old session, create new with new provider
- **Scheduler triggers via processInput()** — same path as user messages, no special state
- **MCP tools are the only way agents interact with codever** — no special protocols

## Implementation Phases

```
P0-P3 ✅ → P4 (Dead Code Cleanup) → P5 (Middleware Simplification) → P6 (Bridge Refactoring) → P7 (MCP + Scheduler)
```

### P0-P3: Original Architecture — ✅ DONE

CoreSession, middleware pipeline, transport decoupling completed. See git history for details.

### P4: Dead Code Cleanup (Zero Risk)

Delete ~2,100 lines of dead code:
- `src/loop.ts` — zero callers
- `src/providers/telegramLauncher.ts` — only called by loop.ts
- `src/session/Session.ts` — old Session class, never instantiated in active paths
- `src/claude/utils/permissionHandler.ts` — duplicate of permissionUI.ts
- `src/providers/claude/` — deprecated ClaudeProvider (doesn't use ACP)
- `src/claude/sdk/` (query/stream/types) — only used by ClaudeProvider
- `src/claude/claudeSessions.ts` — only used by ClaudeProvider
- `src/providers/codebuddy/eventAdapter.ts` — dead old-SDK adapter
- `src/telegram/keyboard.ts` — duplicate of transport/telegram/keyboard.ts
- `src/telegram/formatter.ts` — zero callers

Move shared utils: `claude/sdk/utils.ts` → `utils/nodePath.ts`, `claude/utils/generateHookSettings.ts` → `utils/hookSettings.ts`, `claude/utils/startHookServer.ts` → `utils/hookServer.ts`

Fix bugs: `/status` uses wrong session map, `getCwdForChat()` queries old Session, daemon hook server uses old lookup.

### P5: Middleware Simplification

- Delete `permission.ts` middleware (redundant with TelegramPermissionHandler)
- Inline dedup into pipeline (Set<string>)
- Move `splitHtmlChunks` to `utils/formatting.ts`, inline content-limit into pipeline
- Add `structureDetector.ts` for markdown-aware flush (tables, code blocks, lists)
- Implement tool call progressive display (brief buffer + ChannelPort.edit)

### P6: Bridge Refactoring

- Extract `ChannelPort` interface
- Create `sessionBridge.ts` replacing `coreSessionLauncher.ts`
- Create `TelegramPort` implementing `ChannelPort`
- Move `coreSessionRunners` into `SessionManager`
- Fix provider switch (destroy + recreate instead of name change)
- Merge `src/telegram/` into `src/channel/telegram/`

### P7: MCP Server + Scheduler

- Implement MCP server (stdio transport) with tools: schedule_reminder, list_sessions, switch_session, etc.
- Implement `Scheduler` with config persistence
- Wire `mcpServers` in `AcpProvider.startQuery()`

## File Map (Target State)

```
src/
  core/                              # Channel-agnostic, provider-agnostic
    session.ts                       # CoreSession state machine
    eventBus.ts                      # DefaultEventBus
    types.ts                         # SessionEvent types
    scheduler.ts                     # Timed task scheduling

  bridge/                            # Wires core + provider + channel
    sessionBridge.ts                 # CoreSession + Provider + ChannelPort + Pipeline wiring
    channelPort.ts                   # ChannelPort interface + types
    sessionManager.ts                # Session lifecycle + persistence

  channel/                           # Channel implementations
    telegram/
      telegramPort.ts                # ChannelPort implementation
      renderer.ts                    # Telegram message sending
      permissionUI.ts                # Permission inline keyboard
      keyboard.ts                    # Keyboard builders
      agentFormatter.ts              # AgentEvent → HTML/Markdown
      ConversationModel.ts           # Tool call state tracking
      pairing.ts                     # User pairing
      handlers/                      # Command/callback handlers
      bot.ts                         # Bot factory

  mcp/                               # MCP server (agent → codever tools)
    server.ts                        # MCP server entry point
    tools/                           # Tool implementations

  middleware/                         # Output processing
    pipeline.ts                      # Structure-aware buffering + flush + dedup + content-limit
    structureDetector.ts             # Markdown structure detection
    formatting.ts                    # AgentEvent → Markdown/HTML
    timeout.ts                       # Heartbeat + timeout detection
    types.ts                         # Middleware interface

  providers/                          # ACP protocol layer
    provider.ts                      # AgentProvider interface
    types.ts                         # AgentEvent types
    registry.ts                      # Provider registry
    acp/                             # AcpProvider + AcpClientManager + eventAdapter
    opencode/                        # OpencodeProvider
    codebuddy/                       # CodebuddyProvider

  utils/
    formatting.ts                    # escapeHtml + splitHtmlChunks
    nodePath.ts                      # resolveNodePath
    hookSettings.ts                  # generateHookSettingsFile
    hookServer.ts                    # startHookServer
    tgmdrender.ts                    # Python tgmdrender wrapper
    ...

  config.ts
  daemon.ts                          # Composition root
```
<!-- architecture:end -->
