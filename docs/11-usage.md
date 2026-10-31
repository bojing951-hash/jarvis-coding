# 11 · 使用手册：在飞书里怎么用 JARVIS

所有操作都从飞书私聊 JARVIS 开始。下面是可用的说法与它会做的事。

## 0. 先自检

任何时候想知道系统状态：

```bash
~/.openclaw/tools/node/bin/node ~/JarvisCoding/orchestrator/src/cli.mjs doctor
```

9 项检查：openclaw / gateway / feishu / providers / state / agent 一致性 / executor / notify / security。

## 1. 建项目

> 创建一个项目「投资研究」，slug 用 invest。

JARVIS 调用 `project_create`，目录落在 `~/.openclaw/projects/invest/`。

## 2. 建 Agent（指定模型）

> 在 invest 里建两个 Agent：analyst 用 zai/glm-4.6，reviewer 用 zai/glm-5.3-flash。

模型与角色是分开的：换模型不影响角色和历史会话。

> 把 reviewer 的模型换成 zai/glm-5.3。

## 3. 直接对话（不产生任务）

> 跟 analyst 聊聊：帮我看看这条结论有没有漏洞。

JARVIS 用 `talk`，每次是**独立会话**，不会和别的对话串味。

## 4. 交接（会产生任务与执行证据）

> 让 analyst 回答「个人知识库最该先解决什么」，再把结果交给 reviewer 指出风险。

这是跨 Agent 交接的首选说法。JARVIS 会用 `handoff`，把原始要求、成果、限制条件打包给接收方，
并记录执行证据（模型、耗时、输出）。

## 5. 需要审批的任务

> 建一个任务，让 writer 写方案，写之前先让我确认。

任务状态为待审批；你回复「批准」后 JARVIS 才会执行：

> 批准这个任务。

## 6. 工作流（多阶段）

> 建一个工作流：第一阶段 analyst 和 reviewer 并行研究，第二阶段 writer 汇总分歧，最后给我结论。

对应 `workflow_create` + `workflow_run`。阶段间串行、阶段内并行；
`approve` 阶段会停下来等你批准；`maxRounds` 防止无限跑。

## 7. 让 Claude Code 执行编程任务

> 在 sandbox 目录里修一下 add 函数的 bug，改完跑测试，通过就提交。

JARVIS 建 `executor` 任务，由 Claude Code + GLM 执行。
默认只读；要它改代码必须同时满足「任务已批准」和「执行器 approved」。

## 8. 固定版本审计

> 审计 sandbox 仓库的 49638a2 这个 commit，按这四条契约逐条判断。

审计在**该 commit 的只读工作树**里进行，`worktreeClean=true` 证明没改动被审代码。

## 9. 暂停与恢复

> 暂停 invest 项目。

暂停后该项目不再执行新任务，状态保留；恢复后接着来。

## 10. 查状态

> 看看 invest 现在什么情况。

返回 Agent 列表、任务统计、等待你决策的事项。

---

## 它会明确拒绝 / 报错的情况

| 情况 | JARVIS 的实际行为 |
|---|---|
| 没有某个模型凭据 | 报「模型不可用」，不会编造回答 |
| 任务需要审批但未批准 | 返回 `blocked: needs_approval` |
| 项目已暂停 | 返回 `blocked: project_paused` |
| 同名 Agent 跨项目 | 报歧义并列出候选，要求用 `项目/名称` |
| 执行器超时或失败 | 返回真实错误与退出码 |

**判断它有没有真干的唯一标准**：`executions` 表里有没有对应记录。
回复文本可能是模型自己编的，但执行记录不会。

```bash
sqlite3 ~/.openclaw/jarvis/state.db \
  "SELECT started_at,status,model,substr(output,1,50) FROM executions ORDER BY started_at DESC LIMIT 5;"
```

## 支持的模型

当前只有 `zai`（GLM 系列）有凭据：

```text
zai/glm-5.3        zai/glm-4.6        zai/glm-5.2
zai/glm-5.3-flash  zai/glm-4.5-air    zai/glm-5-turbo
```

要接 GPT / Claude / DeepSeek，需要先加对应 provider 的 Key，然后：

```bash
openclaw config set models.providers.openai.models '[{"id":"gpt-5.1"}]' --strict-json
```

（不同 provider 的模型 id 以 `openclaw models list --all` 为准。）
