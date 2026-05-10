# Codever 调试指南

## 日志系统概述

Codever 使用 `GroupLogger`（`src/utils/groupLogger.ts`）实现按群组分目录的日志系统。所有日志同时写入文件和控制台。

### 核心工具：GroupLogger

`GroupLogger` 提供两个写入通道：

| 方法 | 目标文件 | 用途 |
|------|----------|------|
| `global(line)` | `logs/<source>/global.log` | 无群组上下文的全局事件 |
| `group(chatId, line)` | `logs/<source>/groups/<chatId>/session.log` | 特定群组的事件 |
| `both(chatId, line)` | 根据 chatId 是否为 null 自动选择 global 或 group | 通用场景 |

每行日志格式：`[ISO8601时间戳] <内容>`

---

## 日志目录结构

```
~/.config/codever/
├── daemon.pid                              ← 守护进程 PID
├── logs/
│   ├── daemon/
│   │   ├── global.log                      ← 全局日志
│   │   └── groups/
│   │       ├── -1001234567890/
│   │       │   └── session.log             ← 该群组的 daemon 事件
│   │       └── -1009876543210/
│   │           └── session.log
│   └── testbot/
│       ├── global.log                      ← testbot 全局日志（启动、错误）
│       └── groups/
│           ├── -1001234567890/
│           │   └── session.log             ← 该群组的消息记录
│           └── -1009876543210/
│               └── session.log
```

**群组 ID 说明：** Telegram 群组的 `chat.id` 通常是负数（如 `-1001234567890`），作为目录名时会保留负号。

---

## Daemon 日志

### 全局日志 (`logs/daemon/global.log`)

来源：`src/daemon.ts` 中 `process.stdout.write` / `process.stderr.write` 重定向。

记录内容：
- 守护进程启动/关闭
- Provider 初始化状态（ready / NOT READY）
- Hook server 启动
- Bot polling 启动
- 未绑定群组的错误（如无 bot token）
- `console.log` / `console.error` 的所有输出（因为 stdout 被重定向）

示例：
```
[2026-04-24T18:30:00.000Z] [daemon] Starting codever daemon...
[2026-04-24T18:30:00.100Z] [daemon] Global log: ~/.config/codever/logs/daemon/global.log
[2026-04-24T18:30:01.500Z] [daemon] Provider "opencode": ready
[2026-04-24T18:30:01.501Z] [daemon] Provider "codebuddy": NOT READY (init pending)
[2026-04-24T18:30:02.000Z] [daemon] Telegram bot polling started
```

### 群组日志 (`logs/daemon/groups/<chatId>/session.log`)

来源：
- `src/transport/telegram/handlers/messageRouter.ts` — 群组事件（bot 被添加、消息接收、session 创建/销毁）
- `src/bridge/topicSession.ts` / `src/runtime/semanticSessionRuntime.ts` — topic session 输入、runtime turn、agent 输出、状态变更、权限、超时、重连

**messageRouter 记录的事件：**

| 前缀 | 内容 | 触发时机 |
|------|------|----------|
| `[bot]` | `my_chat_member: userId=... status=...` | Bot 被添加到群组或权限变更 |
| `[bot]` | `Unauthorized user ...` | 未授权用户添加 bot |
| `[bot]` | `Already has session` | 群组已有活跃 session |
| `[msg:in]` | `userId=... text="..."` | 收到群组消息 |
| `[msg:in]` | `User ... not authorized` | 未授权用户消息被忽略 |
| `[session]` | `Created QueryLoop id=... provider=...` | 新 topic session 元数据被创建 |
| `[session]` | `Failed to acquire creation lock` | 并发创建 session 冲突 |
| `[session]` | `Session dead, cleaned up` | Session 被销毁 |

**Semantic runtime 记录的事件：**

| 前缀 | 内容 | 触发时机 |
|------|------|----------|
| `[session]` | runtime/provider 初始化、配置更新 | TopicSession / SemanticSessionRuntime 初始化 |
| `[session]` | `State: idle → querying` 等 | Runtime 状态转换 |
| `[query]` | `Started: queryId=... model=...` | 查询开始 |
| `[query]` | `Session init: providerSessionId=...` | Provider session 初始化 |
| `[query]` | `Completed: status=...` | 查询完成 |
| `[query]` | `Error: ...` | 查询出错 |
| `[query]` | `Timeout: ...s` | 查询超时 |
| `[query]` | `Message queued: #N` | 查询期间消息排队 |
| `[query:text]` | `...` (截断200字符) | Agent 文本输出 |
| `[query:tool_use]` | `toolName input=...` (截断150字符) | Agent 调用工具 |
| `[query:tool_result]` | `toolName output=...` (截断150字符) | 工具返回结果 |
| `[query:done]` | `status=... duration=...ms cost=...usd` | Agent 完成任务 |
| `[msg:in]` | `username: text` (截断100字符) | 用户消息推入 session |

示例：
```
[2026-04-24T18:30:05.000Z] [session] Created QueryLoop id=abc12345 provider=opencode
[2026-04-24T18:30:05.001Z] [session] TopicSession runtime created: provider=opencode model=default
[2026-04-24T18:30:05.002Z] [session] State: idle → querying
[2026-04-24T18:30:05.003Z] [query] Started: queryId=def67890 model=default
[2026-04-24T18:30:05.100Z] [msg:in] anciety: 帮我修复 login 的 bug
[2026-04-24T18:30:06.500Z] [query] Session init: providerSessionId=sess-xyz model=claude-3.5
[2026-04-24T18:30:07.000Z] [query:text] 我来帮你修复 login 的 bug。首先让我查看相关文件...
[2026-04-24T18:30:08.000Z] [query:tool_use] Read input={"file_path":"/src/auth/login.ts"}
[2026-04-24T18:30:09.000Z] [query:tool_result] Read output={"content":"export function login() {..."}
[2026-04-24T18:30:15.000Z] [query:done] status=success duration=9970ms cost=0.003usd
[2026-04-24T18:30:15.001Z] [query] Completed: status=success
[2026-04-24T18:30:15.002Z] [session] State: querying → idle
```

---

## TestBot 日志

### 全局日志 (`logs/testbot/global.log`)

记录 testbot 启动错误等非群组事件。

### 群组日志 (`logs/testbot/groups/<chatId>/session.log`)

记录群内所有消息，区分用户和 Bot。

**日志格式：**

| 方向 | 前缀 | 说明 |
|------|------|------|
| 用户消息 | `[USER]` | 来自真实用户的消息 |
| Bot 消息 | `[BOT]` | 来自项目 bot 的消息 |
| 编辑消息 | `[EDITED]` | 消息被编辑 |

示例：
```
[2026-04-24T18:30:05.100Z] [USER] @anciety: 帮我修复 login 的 bug
[2026-04-24T18:30:05.500Z] [BOT] @codever_bot [BOT]: 🚀 Session started
[2026-04-24T18:30:06.000Z] [BOT] @codever_bot [BOT]: 我来帮你修复 login 的 bug...
[2026-04-24T18:30:08.000Z] [BOT] @codever_bot [BOT]: 🔧 Executing tool Read for 2s...
[2026-04-24T18:30:15.000Z] [BOT] @codever_bot [BOT]: ✅ 已完成修复
```

---

## 调试工作流

### 1. 启动 TestBot

```bash
codever testbot                     # 使用默认日志路径
codever testbot --log-dir /tmp/logs # 自定义日志路径
```

前提：已配置 test bot token：
```bash
codever config set-test-bot-token <token>
```

### 2. 查看群组日志

```bash
# Daemon 日志（查看某群组的 session 事件）
cat ~/.config/codever/logs/daemon/groups/-1001234567890/session.log

# TestBot 日志（查看某群组的消息交互）
cat ~/.config/codever/logs/testbot/groups/-1001234567890/session.log

# 实时跟踪
tail -f ~/.config/codever/logs/daemon/groups/-1001234567890/session.log

# 全局日志（启动/错误）
cat ~/.config/codever/logs/daemon/global.log
```

### 3. Agent 调试场景

当 agent 需要调试某群组的问题时，可以读取两个日志文件：

| 文件 | 用途 |
|------|------|
| `logs/daemon/groups/<chatId>/session.log` | 了解 daemon 内部事件流：session 生命周期、查询状态、agent 输出、错误 |
| `logs/testbot/groups/<chatId>/session.log` | 了解 Telegram 中的真实消息交互：用户发了什么、bot 回了什么、时序关系 |

两个日志的时间戳均为 ISO 8601，可以直接对齐时间线交叉对比。

### 4. TestBot 群内命令

| 命令 | 功能 |
|------|------|
| `/testlog` | 最近 50 条消息（本群，紧凑格式） |
| `/testdump` | 完整输出（本群，含 extra 信息） |
| `/testlast` | 最近 20 条消息（所有群） |
| `/testcount` | 消息统计（本群） |
| `/testpath` | 显示日志文件路径 |
| `/testclear` | 清除内存中的本群日志 |
| `/testhelp` | 帮助 |

### 5. 常见问题排查

| 问题 | 检查哪个日志 | 搜索关键词 |
|------|-------------|-----------|
| Bot 无响应 | daemon 群组日志 | `[query] Timeout` / `[query] Error` |
| 消息丢失 | testbot 群组日志 | 对比 `[USER]` 和 `[BOT]` 的时间线 |
| Session 无法创建 | daemon 群组日志 | `[session] Failed to acquire` / `[session] Created` |
| Provider 不可用 | daemon 全局日志 | `NOT READY` / `init failed` |
| 权限问题 | daemon 群组日志 | `Unauthorized` |
| Agent 输出异常 | daemon 群组日志 | `[query:done] status=error` |
