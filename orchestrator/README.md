# jarvis-orchestrator

JARVIS P1 的调度层。**不重写聊天引擎**：会话、模型调用、Agent 全部复用 OpenClaw，
本层只补齐 OpenClaw 没有的「项目 / 任务 / 交接 / 工作流」状态与路由。

## 六类对象

| 对象 | 承载者 | 说明 |
|---|---|---|
| Project | 本层 SQLite + 目录 | 隔离边界：会话、资料、权限不跨项目 |
| Agent | OpenClaw agent | 模型 + 角色 + 工作区，模型与角色可独立替换 |
| Conversation | OpenClaw session | 独立上下文，互不污染 |
| Task | 本层 SQLite | 一次具体执行，含状态、重试、审批 |
| Workflow | 本层 SQLite | 阶段式 DAG：同阶段并行、阶段间串行 |
| Execution | 本层 SQLite | 每次调用的真实证据（模型、耗时、错误、git 版本） |

## 依赖

- Node ≥ 24（用 OpenClaw 自带的私有 Node：`~/.openclaw/tools/node/bin/node`）
- OpenClaw CLI 在 `PATH` 中
- 零第三方依赖，SQLite 用 `node:sqlite`

## 状态位置

```text
~/.openclaw/jarvis/state.db      项目 / 任务 / 工作流 / 执行证据
~/.openclaw/projects/<slug>/     项目目录，每个 agent 一个子工作区
```

## 命令行

```bash
J="~/.openclaw/tools/node/bin/node ~/JarvisCoding/orchestrator/src/cli.mjs"

# 项目
$J project create --name "研究项目" --slug research
$J project show --project research
$J project pause --project research

# Agent（模型与角色独立）
$J agent create --project research --name analyst --model zai/glm-4.6 --role "你做事实核查"
$J agent model --agent analyst --model zai/glm-5.3     # 换模型，保留角色与会话
$J agent role --agent analyst --role "你做审计"

# 对话（同 --conversation 续接，不同则隔离）
$J talk --agent analyst --message "帮我查一下 X"

# 交接（真实执行，不是模拟）
$J handoff --project research --from analyst --to reviewer \
  --requirement "评估这份结论" --artifact "结论：…"

# 任务
$J task create --project research --title "写初稿" --agent analyst --input "…" [--needs-approval]
$J task run --task tsk_xxx
$J task approve --task tsk_xxx

# 外部执行器（Claude Code + GLM）
$J task create --project research --title "只读检查" --kind executor \
  --executor claude-code --cwd /path/to/repo --mode plan --input "说明这个仓库做什么"

# 工作流
$J workflow create --project research --name "研究流" --spec-file spec.json
$J workflow run --workflow "研究流"
```

所有命令加 `--json` 输出机器可读结果。

## 工作流 spec

```json
{
  "maxRounds": 5,
  "stages": [
    { "name": "并行研究", "parallel": true, "nodes": [
      { "agent": "researcher", "title": "研究A", "input": "…" },
      { "agent": "reviewer",   "title": "研究B", "input": "…" }
    ]},
    { "name": "人工确认", "approve": true, "nodes": [
      { "agent": "writer", "title": "定稿", "input": "…" }
    ]},
    { "name": "执行", "nodes": [
      { "executor": "claude-code", "title": "改代码", "input": "…",
        "executorConfig": { "cwd": "/repo", "mode": "plan" } }
    ]}
  ]
}
```

阶段间串行，阶段内按 `parallel` 决定并发；`approve: true` 会暂停并生成待审批任务；
`maxRounds` 防止无限循环。

## MCP 工具（飞书里的 JARVIS 使用）

```bash
openclaw mcp add jarvis-control \
  --command ~/.openclaw/tools/node/bin/node \
  --arg ~/JarvisCoding/orchestrator/src/mcp.mjs \
  --cwd ~/JarvisCoding --timeout 600
```

暴露 22 个工具：`project_*`、`agent_*`、`conversation_*`、`talk`、`handoff`、
`task_*`、`workflow_*`、`models_list`。

JARVIS 主 Agent **不需要** Shell 权限即可调度——权限面保持最小。

## 测试

```bash
~/.openclaw/tools/node/bin/node --test orchestrator/test/*.test.mjs
```
