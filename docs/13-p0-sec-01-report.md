# 13 · P0-SEC-01 开发交付报告

> 状态：**开发交付完成，尚未通过独立验收。**
> 最终结论只能由独立审计（Agent 2）依据 AC v1.0 判定。

## 1. 基线

| 项 | 值 |
|---|---|
| 仓库 | `bojing951-hash/jarvis-coding` |
| 固定开发基线 | `4333e82593b19412739cbf86b8dffcd6c2d227b4` |
| 基线校验 | `origin/dev/...` HEAD 与预期一致；工作区 CLEAN |
| 开发分支 | `fix/p0-sec-01`（从基线直接创建，未改动原分支） |
| `main` | 未改动 |

## 2. 变更文件

```text
docs/12-p0-sec-01-ac.md            冻结契约
orchestrator/src/security.mjs      新增（安全模块，184 行）
orchestrator/src/service.mjs       执行链路重写 + 审批/校验配置
orchestrator/src/executor.mjs      去 shell、作用域提交、环境白名单
orchestrator/src/mcp.mjs           移除 task_approve、字段白名单
orchestrator/src/cli.mjs           管理员入口（operator / verify-profile / approve）
orchestrator/src/db.mjs            verify_profiles、approvals、任务列
orchestrator/test/security.test.mjs 新增 17 项安全测试
```

## 3. 修复的实际缺陷

| 缺陷 | 修复方式 |
|---|---|
| 一、间接 Shell 执行 | 删除 `/bin/sh -c` 路径；校验配置由管理员登记，任务只能引用 id；执行走 `execFile(program, argv, shell:false)` |
| 二、审批可被配置冒充 | 删除 `executor_config.approved` 语义；写模式/提交必须有 `approvals` 记录；MCP 移除 `task_approve` |
| 三、测试失败仍提交 | 提交门禁要求 `verify.exitCode === 0`；`git add` 改为声明路径白名单 |
| 四、取消失效 | 校验前、提交前两次状态检查；无法确认终止时标记 `cancel_requested` 并返回失败 |
| 五、执行范围无约束 | `realpath` 归属校验，越界/穿越/符号链接逃逸拒绝；子进程环境变量白名单 |

## 4. 关键实现

**可信控制面与不可信输入的分界**

- 不可信：MCP 参数、任务 `executor_config`、Workflow `node.executorConfig`、Agent 输出
- 可信：本地管理员 CLI（`operator init` / `verify-profile add` / `approve`）+ 数据库记录

Agent 没有 Shell，MCP 工具集中**不存在**签发审批或登记校验配置的能力，因此不可信输入无法自行提权。

**审批绑定参数摘要**

```text
digest = sha256(canonical({
  task_id, project_id, executor, mode, cwd,
  verify_profile_id, commit, commit_paths, input_sha
}))
```

任一项变化 → 摘要不同 → 旧审批失效。审批记录单次使用（`used_at`）、可过期、可撤销。

## 5. 测试命令与结果

```bash
~/.openclaw/tools/node/bin/node --test orchestrator/test/*.test.mjs
```

```text
tests 31 / pass 31 / fail 0
```

- 既有回归：14 项（项目、任务状态机、审批门、重试上限、JSON 解析等）
- 新增安全：17 项（见下）

## 6. 负向测试结果

| 场景 | 结果 |
|---|---|
| `executor_config.verify` 注入 | 拒绝：`不允许的执行器字段: verify` |
| Workflow 节点携带 `verify` | 拒绝（同一校验函数） |
| 登记 shell 为校验程序 | 拒绝：`不允许把 shell 解释器登记为校验程序` |
| `approved=true` 伪装 | 拒绝：字段不在白名单 |
| 无审批的 `acceptEdits` | `blocked: needs_approval` |
| 历史 `approved_at` | 不授权执行器，仍 `needs_approval` |
| 审批后改 cwd | 摘要变化，审批失效 |
| 跨项目 cwd | `path_outside_project` |
| `../..` 穿越 | 拒绝 |
| 校验失败/缺失/无提交范围 | 均不提交 |
| 并发启动同一任务 | `already_running` |
| 子进程环境含密钥 | 被白名单剥离 |

## 7. 真实执行证据

沙箱仓库 `~/.openclaw/projects/p1-orch/sandbox`（一次性测试仓库）：

```text
task        tsk_mvwdut98016swg
approval    apv_mvwduvu301j2b9  digest=6fcfb91d…
verify      program=npm argv=["test"] exit=0
commit      ok=true sha=ed8b6c0333 files=["src/calc.mjs"]
提交前 HEAD  8b7286a
```

实际提交只包含 `src/calc.mjs`，`npm test` 结果 `pass 2 / fail 0`。
未审批时同一任务返回 `blocked: needs_approval`；审批使用后再次执行被拒，`used_at` 已写入。

## 8. 安全策略说明

- 拒绝优先（fail closed）：缺少校验配置、审批、提交范围时一律不执行副作用
- 最小暴露：MCP 工具从 24 个变为 23 个（移除 `task_approve`，新增只读 `approval_list`）
- 子进程只继承 `PATH/HOME/LANG/LC_ALL/TERM/TMPDIR/USER`
- 证据落库：`executions.evidence` 含 plan、approval id、verify 退出码、commit sha

## 9. 已知限制

1. **审批来源是本地 CLI**，不是经过认证的远程用户。MCP 会话中无法证明「用户本人点了批准」，因此飞书端审批未在本轮实现，也未标记 PASS。
2. **执行器仍以同一 OS 用户运行**，没有操作系统级沙箱（无 seatbelt/容器）。目录约束是路径校验，不是内核级隔离。
3. 取消依赖 SIGTERM，恶意进程忽略信号时只能标记 `cancel_requested`，需人工核查。
4. 校验配置目前只能通过 CLI 登记，尚无管理界面。
5. 审计任务未使用新的校验配置机制（仍为只读 worktree 快照）。

## 10. AC 对应关系

| AC | 证据 |
|---|---|
| AC-01 | `security.mjs:validateExecutorConfig`；`executor.mjs:runVerifyProfile`（`shell:false`）；测试 4 项 |
| AC-02 | `service.mjs:issueApproval` / `findValidApproval`；`mcp.mjs` 已无 `task_approve`；测试 3 项 |
| AC-03 | `security.mjs:taskDigest`；测试「审批后修改执行参数」 |
| AC-04 | `security.mjs:resolveProjectPath`；测试 2 项 |
| AC-05 | `security.mjs:commitGate`；`executor.mjs:gitCommit(paths)`；测试 4 项 + 真实提交 |
| AC-06 | `service.mjs:cancelTask`（`cancel_requested`）+ 校验/提交前 `isCancelled()` |
| AC-07 | `UPDATE ... WHERE status IN (...)` 原子转换；测试 `already_running` |
| AC-08 | 工作流节点与普通任务共用 `resolveExecutorPlan`；测试 |
| AC-09 | `approved_at` 不参与执行器授权；测试 |
| AC-10 | `evidence.plan/authorization/verify/commit`；真实执行记录 |
| AC-11 | 既有 14 项测试全绿；JARVIS 经 MCP 查询回归成功 |

## 11. 回滚方法

本轮全部改动在独立分支，未合并：

```bash
git checkout dev/jarvis-general-orchestrator   # 回到安全修复前
git branch -D fix/p0-sec-01                     # 丢弃本分支（如未推送）
```

数据库层面新增了 `verify_profiles`、`approvals` 两张表与两个任务列，迁移是增量的，
旧代码可以继续运行（多余列被忽略）。如需彻底回退：

```bash
rm ~/.openclaw/jarvis/state.db   # 会丢失全部项目/任务状态，慎用
```

管理员密钥位于 `~/.openclaw/jarvis/operator.key`，回滚后可保留或删除。
