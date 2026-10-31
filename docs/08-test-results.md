# 08 · 测试结果（真实执行）

环境：macOS 15.6.1 / Apple M4 / OpenClaw 2026.10.9 / 私有 Node 24.22.1
执行时间：2026-10-31

## 可用模型清单（决定 TEST-01 的边界）

> 补充：另有一个**本地 mock provider** 验证脚本，证明「接第二个 provider 只需配置、不改代码」。
> 见本文末尾「Provider 可插拔性」。该验证使用 mock 服务，**不代表已接入真实厂商**。

`openclaw models list` 实际可用：**只有 zai（GLM 系列）有凭据**。

```text
zai/glm-5.3        zai/glm-4.6        zai/glm-5.2
zai/glm-5.3-flash  zai/glm-4.5-air    zai/glm-5-turbo …
```

本机**没有** OpenAI / Anthropic / DeepSeek 的 API Key。
因此 TEST-01 的「GPT / Claude / DeepSeek」部分标记为 **WAITING**，
已用同一 provider 下三个**真实不同模型**验证了机制本身。

---

## TEST-01 多模型独立会话

| 子项 | 结果 | 证据 |
|---|---|---|
| 创建独立会话 | PASS | `sess-alpha` / `sess-beta` |
| 指定模型真实生效 | PASS | `model=zai/glm-4.6`、`zai/glm-5.3-flash`、`zai/glm-5.3` |
| 多轮连续性 | PASS | 回访答出 `74219` |
| 会话不混淆 | PASS | 另一会话答「不知道…这个会话里没有」 |
| 删除/归档会话 | PASS | `openclaw sessions archive/delete` 原生支持 |
| GPT / Claude / DeepSeek | **WAITING** | 缺对应 API Key，未冒充完成 |

## TEST-02 跨 Agent 通信

| 子项 | 结果 | 证据 |
|---|---|---|
| A → B 真实交接 | PASS | `researcher(glm-4.6)` → `reviewer(glm-5.3-flash)` |
| 接收方真实执行 | PASS | 任务 `tsk_mvw867gw01m8vj` status=done |
| 结果返回 | PASS | reviewer 输出完整评审报告并落库 |
| 不复制全量历史 | PASS | 交接输入只含任务字段 |
| 失败不虚报 | PASS | 失败路径返回 `ok:false` + 真实 error |

## TEST-03 非编程工作流

两阶段并行研究 + 汇总，全部真实模型调用：

```text
[并行研究] researcher(glm-4.6)     → 三条优先自动化建议
[并行研究] reviewer(glm-5.3-flash) → 三个高估/踩坑点
[汇总]     writer(glm-5.3)         → 共识 / 分歧 / 建议
```

结果：`workflow status=done`，汇总确实指出了两份研究的**分歧点**（记忆优先级、扩展驱动方式）。

## TEST-04 编程工作流

| 子项 | 结果 | 证据 |
|---|---|---|
| Claude Code + GLM 真实执行 | PASS | `claude 2.1.104`，exitCode=0，耗时 23s |
| 只读模式生效 | PASS | `gitHeadBefore == gitHeadAfter`，`gitChanged=false` |
| 读取真实文件 | PASS | 回答了探针目录 README 的内容 |
| 返回 Commit / 测试证据 | 部分 PASS | 已记录 git HEAD 前后；未做写模式改动 |
| 写模式（acceptEdits） | **NOT IMPLEMENTED 验证** | 代码已实现审批门，未在真实仓库测试 |
| 独立 Auditor 审固定版本 | **NOT IMPLEMENTED** | 需真实 Git 仓库与冻结契约，未做 |

## TEST-04b 执行器写模式（沙箱实测）

在一个**一次性沙箱仓库**（`~/.openclaw/projects/p1-orch/sandbox`，含真实 bug 与真实失败测试）上执行，未触碰任何真实项目。

| 阶段 | 证据 |
|---|---|
| 初始状态 | `npm test` → `pass 1 / fail 1`（`add` 误用减法） |
| 审批门 | 未批准时 `task run` → `blocked: needs_approval` |
| 模型改码 | `git diff` 显示 `add` 改为 `+`，仅 1 行变更 |
| 编排层校验 | `verify: npm test` → exit 0，`pass 2 / fail 0` |
| 提交 | `commit.sha = 49638a2`，`git log` 可见 |

第二轮（`mul` 误用加法）同样走完「改码 → 测试 → 提交」全链路，
commit 消息 `fix(calc): mul 使用加法，修正为乘法`。

**限制说明**：Claude Code 自身没有 Bash 权限，跑不了测试（它如实报告了这一点）。
因此测试执行由**编排层**完成（`executorConfig.verify` 是运维指定的固定命令，不是模型生成的），
这样既拿到真实测试证据，又没有放宽模型的权限。

## TEST-04c 审计（固定 commit + 冻结契约）

```text
kind=audit  repo=<sandbox>  commit=49638a2b  contract=4 条验收项
```

| 子项 | 结果 |
|---|---|
| 只读固定版本 | PASS，证据 `audit.commit=49638a2b` |
| 不得修改被审代码 | PASS，`worktreeClean=true` |
| 独立上下文 | PASS，独立 worktree + 独立 session |
| 逐条对照契约 | PASS，给出 `src/calc.mjs:1` / `:2` 行号级证据 |
| 不臆造 | PASS，明确写出「Bash 未获授权，故未动态跑测试」 |

## TEST-06b 取消与通知

| 子项 | 结果 | 证据 |
|---|---|---|
| 取消执行器任务 | PASS | `cancelTask` 杀进程组，`task=cancelled` / `execution=cancelled` |
| 取消后不被回写覆盖 | PASS | 曾出现 `failed` 覆盖 `cancelled` 的竞态，已用 `WHERE status='running'` 守卫修复 |
| 工作流完成通知 | PASS | `notify: {sent: true}`，飞书收到消息 |
| 通知失败不阻塞主流程 | PASS | `notify()` 捕获异常只记事件 |

## TEST-05 多项目隔离

| 子项 | 结果 | 证据 |
|---|---|---|
| 项目目录隔离 | PASS | `~/.openclaw/projects/<slug>/agents/<name>` |
| Agent 归属校验 | PASS | 跨项目指派直接抛错 |
| 暂停 A 继续 B | PASS | `project_paused` 拦截，其余项目不受影响 |
| 恢复 A | PASS | 状态与光标保留 |

## TEST-06 重启恢复

```text
1. 工作流跑到审批门 → status=paused, cursor=1
2. openclaw gateway restart
3. 重启后：审批门测试 paused cursor=1（未丢）
           AI总管优先级研究 done cursor=2（未回滚）
4. task approve → 重新 run → 继续到 done
```

| 子项 | 结果 |
|---|---|
| 状态跨重启保留 | PASS |
| 未执行完的不重复执行 | PASS（cursor 定位，已完成阶段不重跑） |
| MCP 服务重启后可用 | PASS（22 tools，probe 通过） |

## TEST-07 安全验证

| 子项 | 结果 | 证据 |
|---|---|---|
| 主 Agent 无 Shell | PASS | 新 session 实测 `Unknown tool id: exec` |
| 密钥不进 Git | PASS | 提交前扫描真实 Key/Token，均未命中 |
| 执行器目录隔离 | PASS | 只传 `cwd`，无 `--add-dir` |
| 执行器默认只读 | PASS | `plan` 模式 + git HEAD 未变 |
| 审计 Agent 只读 | **WAITING** | 审计 Agent 目前是聊天 Agent（无 FS 写权限），未接代码审计流程 |
| 无无限循环 | PASS | `maxRounds` + `max_attempts` 双重上限 |
| 不能擅自合并主干 | PASS | 未配置任何 git push/merge 权限给 Agent |

## TEST-01/02 飞书端到端（W7 实测）

由用户在 iPhone 飞书发起，JARVIS 自行调用 MCP 工具完成。

**第一条消息 → 建项目 + 两个 Agent**

```text
18:45:32 DM: 创建一个新项目「飞书验收」，slug 用 feishu-e2e…
落库：project feishu-e2e
      agent analyst  zai/glm-4.6
      agent reviewer zai/glm-5.3-flash
```

**第二条消息 → 跨 Agent 真实交接**

```text
18:47 首次尝试：task_create / handoff / workflow_run 全部 error
19:01 修复后重试：全部 ok
```

真实执行证据（`executions` 表）：

```text
11:01:17Z ok glm-4.6       个人知识库最该先解决的是"可靠地找回来"…
11:01:38Z ok glm-5.3-flash 风险：该回答默认"未来知道自己该查什么"…
```

对应任务 `tsk_...` 状态均为 `done`，轨迹显示
`jarvis-control__task_create ok` → `task_run ok` → `task_create ok` → `task_run ok`。

结论：**PASS**。JARVIS 未扮演其他 Agent，而是真实调度了两次独立模型调用。

## 实测中发现并修复的缺陷

**同名 Agent 跨项目冲突**（由 JARVIS 在真实执行中报告）：

```text
reviewer 同时存在于 p1-orch 与 p1-verify
→ handoff 报「交接双方必须属于同一项目」
```

根因：`getAgent` 只按名称全局匹配，命中多条时取第一条。

修复：支持 `项目slug/名称` 寻址，并在歧义时抛出带候选列表的明确错误：

```text
Agent 名称有歧义: reviewer（命中 2 个：p1-orch/reviewer、p1-verify/reviewer）。
请用「项目slug/名称」指定。
```

验证：`agent role --agent p1-verify/reviewer` 正常解析；裸 `reviewer` 报歧义。

**第二处：项目内解析未生效**（飞书首次实测暴露）

```text
task_create 报错 / handoff 报错 / workflow_run 报错
```

根因：`createTask` 用全局 `getAgent(assignee)` 而非项目范围，
`analyst` 同时存在于 p1-verify 与 feishu-e2e，导致歧义失败。

修复：`createTask` 改为 `getAgent(assignee, project.id)`；`talk` 增加 `project` 参数。

**第三处：工作流异常后卡在 running**

`runWorkflow` 抛异常时状态不回滚，工作流永远停在 `running cursor=0`。
修复：包一层 try/catch，异常时置 `failed` 并记录事件。

## Provider 可插拔性（本地 mock，非厂商 API）

```text
node orchestrator/scripts/verify-provider-agnostic.mjs
```

| 步骤 | 结果 |
|---|---|
| 本地 mock OpenAI-compatible 服务启动 | PASS |
| 注册第二个 provider（纯配置，零代码改动） | PASS |
| 模型出现在 `models list` | PASS（`mock/mock-1`） |
| 用新 provider 创建 Agent | PASS |
| 真实调用返回预期回复 | PASS（`MOCK_PROVIDER_OK`） |
| 清理并恢复配置 | PASS（providers 回到只有 `zai`） |

结论：接入 GPT / Claude / DeepSeek 属于**配置工作**，不需要改动 orchestrator 代码。
但「真实厂商调用」仍为 WAITING——mock 不能替代真实 API 证据。

## 单元测试

```text
node --test orchestrator/test/*.test.mjs
tests 14 / pass 14 / fail 0
```

覆盖：项目创建与 slug 冲突、审批门拦截、项目暂停拦截、重试上限、空工作流拒绝。
