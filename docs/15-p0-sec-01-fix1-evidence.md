# 15 · P0-SEC-01-FIX1 证据包（提交审计用）

> 状态：**DEVELOPMENT_DELIVERED / PENDING_INDEPENDENT_AUDIT**
> 本文只列可复核的事实与命令输出，不作验收结论。最终判定由 Agent 2 依 `JARVIS-P0-SEC-01-AC-v1.0` 作出。

## EV-01 固定版本

| 项 | 值 |
|---|---|
| 开发基线 | `4333e82593b19412739cbf86b8dffcd6c2d227b4` |
| 上一轮版本（父） | `42bf5dc41d07f4157805023308e5a585831b4563` |
| 开发分支 | `fix/p0-sec-01-fix1` |
| 冻结契约 | `docs/contracts/p0-sec-01-ac-v1.0.md`，sha256 `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0`，21297 bytes，`cmp` 与原件 IDENTICAL |
| `main` | 未改动 |

## EV-04 执行调用链

```text
CLI / MCP
  → createTask(executor_config 白名单校验)
  → runTask
      → resolveExecutorPlan   (路径归属 / repo+base_commit / 校验配置归属)
      → findValidApproval     (摘要绑定、单次使用)
      → isolationStatus       (docker 守护进程 + 镜像 + --internal 网络)
      → 状态机 claim          (pending/authorized/retry_pending → running)
      → createWorktree        (固定 commit，detach，初始必须干净)
      → writeCredentialFile   (0600 临时文件)
      → runClaudeIsolated     (容器：--internal + 白名单代理 + 只读凭据挂载)
      → runInWorkdir          (容器内校验，execFile argv，无 shell)
      → changedFiles          (范围检查)
      → 提交前重查授权与取消
      → gitCommit(paths)      (只 add 声明路径)
      → publishRef            (refs/heads/jarvis/<task>，防 detach 提交丢失)
      → computeVerdict        (完整链路裁决)
      → finalizeAttempt       (Task/Execution 一致写回)
```

## EV-05 审批机制

- 审批记录表 `approvals`：`task_id + digest + scope + issued_by + expires_at + used_at`
- digest = sha256(canonical({task_id, project_id, executor, mode, cwd, repo, base_commit, verify_profile_id, commit, commit_paths, input_sha}))
- 签发入口只有本地 CLI：要求 `process.stdin.isTTY` **且** 显式 `--confirm APPROVE`
- MCP 不提供签发工具；`task_approve` 已移除（仅保留只读 `approval_list`）
- `executor_config.approved` 字段被白名单拒绝；历史 `tasks.approved_at` 不授权执行器

**限制（必须记录）**：本次 E2E 中的审批由开发方通过 pty 完成（`script -q /dev/null`），**不是用户本人的真实批准**。安全含义：JARVIS 无 shell 无法伪造，但任何有 shell 的人可以。

## EV-06/07/08 负向测试（单元）

```text
node --test orchestrator/test/*.test.mjs
tests 45 / pass 45 / fail 0
```

| 覆盖 | 断言 |
|---|---|
| Shell 字段注入 | `verify`/`allowedTools` 等被白名单拒绝 |
| 登记 shell 为校验程序 | 抛错拒绝 |
| `approved=true` 伪装 | 字段非法 |
| 历史 `approved_at` | 仍 `needs_approval` |
| 摘要变更 | 原审批失效 |
| 跨项目目录 | `path_outside_project` |
| `../..` 穿越 | 拒绝 |
| **符号链接指向他项目** | 拒绝（realpath 解析） |
| 提交范围外文件 | 不入 commit |
| 并发启动 | `already_running` |
| 子进程环境 | 密钥变量被剥离 |

## EV-09/10 真实执行（隔离容器内 Claude Code + GLM）

**合法写入（E2E-03）**

```text
task      tsk_mvwikb9c01zssb
approval  apv_mvwigl5601weg1
isolated  true        network jarvis-internal
verify    npm test → exit 0
changed   ["src/calc.mjs"]   outside []
commit    0eedbba1a0f3bfa0dd601b7ac09b95c2ef786fb3
ref       refs/heads/jarvis/tsk_mvwikb9c01zssb  (published true)
verdict   done
```

该 commit 单独 checkout 后 `npm test` → `pass 3 / fail 0`，`div` 为 `a / b`。

**测试失败阻断提交（E2E-04）**

```text
verify    npm run definitely-missing → exit 1
commit    ok=false  skipped=true  reason="校验失败（exit 1）"
task      failed
API ok    false        # 修复了「任务 failed 而 API ok=true」的不一致
仓库       无新 commit、无新 ref
```

**取消竞态（E2E-07）**

```text
cancel    ok=true   container confirmed=true
task      cancelled
execution cancelled
残留容器   无
```

过程中修复两处真实竞态：
1. 取消晚于执行结束 → 任务被写成 `failed`。改为先置 `cancel_requested` 再终止。
2. 杀死 `docker run` 客户端不等于停止容器 → 增加容器命名与 `docker kill` 确认。

## EV-11 提交范围

工作树从固定 commit 创建，初始 `initialClean=true`；`gitCommit` 只 `add` 声明路径，暂存区出现范围外文件即 `reset` 并拒绝。

## EV-12 取消与并发

见上；并发由 `UPDATE ... WHERE status IN (...)` 原子转换保证，重复启动返回 `already_running`。

## EV-13 原有功能回归

45 项测试全绿；JARVIS 经 MCP 查询项目状态正常；E2E-10 非编程工作流真实跑通：

```text
workflow  E2E-10 非编程回归  → done
nodes     researcher / reviewer（并行） / writer（汇总） 全部 ok
```

## EV-15 环境与已知限制

| 项 | 说明 |
|---|---|
| 隔离后端 | Docker Desktop 4.97.0 / Engine 29.9.2，镜像 `jarvis-executor:2.1.104` |
| 网络 | `jarvis-internal`（`Internal=true`，无默认路由）；出口经 `jarvis-proxy` 白名单 |
| 网络实证 | 直连 `1.1.1.1` 失败；代理日志 `[allow] open.bigmodel.cn`、`[deny] api.anthropic.com`、`[deny] example.com` |
| 审批身份 | 本地 TTY + 显式确认，**非平台级身份认证** |
| SIGKILL 升级 | 已实现（TERM→5s→KILL），**尚未用「忽略 SIGTERM 的顽固进程」实测** |
| Docker 许可 | 未替用户接受任何商业条款 |

## 22 项 AC 对照（开发方自评，非验收结论）

| AC | 自评 | 证据 |
|---|---|---|
| AC-01 | 满足 | 分支自 `42bf5dc`，main 未动，diff 仅安全相关 |
| AC-02 | 满足 | 白名单 + 单测；MCP 无 approve 工具 |
| AC-03 | 满足 | `execFile(program, argv, shell:false)`，拒绝 shell 程序 |
| AC-04 | 满足 | 登记制校验配置，未知 id 拒绝 |
| AC-05 | **部分** | A–D 有单测；E 由 pty 完成，非真实用户 |
| AC-06 | 满足 | 摘要绑定 6 项参数 |
| AC-07 | 满足 | 过期/已用/跨任务/旧字段 |
| AC-08 | 满足 | CLI/MCP/Workflow 共用 `resolveExecutorPlan` |
| AC-09 | 满足 | realpath + 前缀 |
| AC-10 | 满足 | 穿移 + 符号链接单测 |
| AC-11 | **部分** | 容器隔离与出网控制有实证；「读环境变量」仅单测 |
| AC-12 | 满足 | E2E-03 真实执行 + commit |
| AC-13 | 满足 | E2E-04 真实阻断 |
| AC-14 | 满足 | 无校验不得提交（单测 + gate） |
| AC-15 | 满足 | 工作树干净 + 路径白名单 |
| AC-16 | 满足 | commit `0eedbba` + ref 可达 + 版本测试一致 |
| AC-17 | 满足 | E2E-07 取消后无新副作用 |
| AC-18 | **部分** | 容器确认 + SIGKILL 升级已实现，顽固进程未实测 |
| AC-19 | 满足 | 原子状态转换 |
| AC-20 | **部分** | 暂停/状态门禁在；重启场景未逐条实测 |
| AC-21 | 满足 | 拒绝也写 executions（phase/blocked/reason） |
| AC-22 | 满足 | 45 项测试 + MCP 回归 + E2E-10 |

## 回滚

```bash
git checkout fix/p0-sec-01        # 回到上一轮
git branch -D fix/p0-sec-01-fix1
docker rmi jarvis-executor:2.1.104 jarvis-egress-proxy:1
docker rm -f jarvis-proxy; docker network rm jarvis-internal
```

数据库为增量迁移（`verify_profiles` / `approvals` 表、任务新列），旧代码可运行。
