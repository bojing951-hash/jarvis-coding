# 07 · 架构：JARVIS P1 通用调度层

## 设计前提

OpenClaw 已经提供了**多 Agent、多会话、模型 Provider、持久化会话存储**。
因此本项目的做法是：**能复用的绝不重写**，只在它缺失的地方加一层薄调度。

缺的是什么：OpenClaw 没有「项目」「任务」「跨 Agent 交接」「工作流」这些概念。
所以新增 `orchestrator/`，约 1000 行、零第三方依赖。

## 分层

```text
飞书 / CLI / MCP
       │
       ▼
  orchestrator（本层新增）
   Project · Task · Workflow · Execution
       │  调用 CLI，不碰内部实现
       ▼
  OpenClaw（复用）
   Agent · Session · Provider · Gateway
       │
       ├── GLM（zai）
       └── Claude Code（外部执行器，独立进程）
```

## 六类对象，严格分离

| 对象 | 落在哪里 | 关键约束 |
|---|---|---|
| **Project** | SQLite + `~/.openclaw/projects/<slug>/` | 项目间不共享工作目录 |
| **Agent** | OpenClaw agent（`jv-<project>-<name>`） | 模型与角色独立可换 |
| **Conversation** | OpenClaw session（`<agentId>:<cnvId>`） | 不同 session 上下文隔离 |
| **Task** | SQLite | 有状态机、重试上限、审批位 |
| **Workflow** | SQLite（spec JSON） | 阶段串行、阶段内并行、轮次上限 |
| **Execution** | SQLite | 每次调用的真实证据 |

对象混用是被明确禁止的：**模型不是角色，角色不是会话，会话不是项目**。
`agent_set_model` 换模型不动角色与会话；`agent_set_role` 改角色不动模型与会话。

## 会话隔离机制

不自己实现记忆，直接映射到 OpenClaw session：

```text
sessionKey = <openclawAgentId>:<conversationId>
```

同一 key → 续接上下文；不同 key → 完全隔离。
Agent 级隔离由 OpenClaw 的 agent 独立 `agentDir` 保证。

实测（sess-alpha 记住 74219，sess-beta 询问）：

```text
S1 写入   → 已记住
S2 询问   → 不知道…这个会话里没有你之前告诉我的数字
S1 回访   → 74219
```

## 模型与角色解耦

```bash
agent create --name analyst --model zai/glm-4.6 --role "你做事实核查"
agent model --agent analyst --model zai/glm-5.3   # 只换模型
agent role  --agent analyst --role "你做审计"       # 只换角色
```

模型不是写死在代码里的：`agent create` 接受任意 `provider/model`，
但会先用 `openclaw models list` 校验，避免运行时才报 `Unknown model`。

## 凭据模型（关键修复）

新 Agent 默认拿不到主 Agent 的凭据（OpenClaw 按 agent 存 auth）。
动态建 Agent 必须解决这一点，否则每个新 Agent 都不可用。

解法：把 GLM Key 提升到 **provider 级 SecretRef**：

```json
"models": { "providers": { "zai": { "apiKey": { "source": "store", "provider": "default", "id": "ZAI_API_KEY" } } } }
```

所有 Agent 共享同一凭据来源，且配置文件中没有明文密钥。
实测证据：`credentialSource: { kind: "direct", evidence: "provider-config" }`。

## 跨 Agent 交接

不是让 JARVIS 扮演多个角色，而是**真的把消息发给另一个 Agent 并等它执行完**。

交接结构（任务输入模板）：

```text
# 任务交接
- 来源 Agent / 目标 Agent / 项目
## 原始要求
## 需要处理的成果
## 必要上下文
## 限制条件
```

只传任务相关材料，不复制来源会话的全量历史。
执行完写一条 `executions` 记录（模型、耗时、错误、session）。

## 外部执行器

Claude Code + 现有 GLM 配置，独立进程，与聊天 Agent 权限分离：

| 约束 | 实现 |
|---|---|
| 目录隔离 | 只传 `cwd`，不传 `--add-dir` |
| 默认只读 | `--permission-mode plan` |
| 写操作需审批 | `acceptEdits` 必须 `executorConfig.approved=true` 且任务已批准 |
| 不用 bypassPermissions | 显式拒绝 |
| 证据 | exitCode / git HEAD 前后 / 耗时 / session / cost |

## 工作流

阶段式而非图式，够用且可解释：

```text
stage[0] 并行节点 → stage[1] 审批门 → stage[2] 顺序节点
```

- 阶段间严格串行，阶段内 `parallel: true` 才并发
- `approve: true` 会暂停并生成待审批任务，工作流 `cursor` 保留
- `maxRounds` 限制总轮次
- 任一节点失败 → 工作流 `failed`，不继续

## 为什么不引入框架

没有消息队列、没有独立数据库服务、没有前端。
状态在 SQLite，进程在 Gateway 里跑 MCP，全部可重启恢复。
