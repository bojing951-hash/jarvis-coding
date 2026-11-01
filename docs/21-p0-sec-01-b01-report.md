# 21 · P0-SEC-01-FIX3-CLOSE-B01 定向修复报告

> 状态：**DEVELOPMENT_DELIVERED / READY_FOR_INDEPENDENT_AUDIT**  
> 不宣布正式验收 PASS。G3 独立验收尚未开始。  
> 修复起点：`db135e3ad2ea120e0848fd12a9fdda40fd3be0d2`  
> 实现目标 Commit：`f2a3f9d8283d41f8496c3f939feff4f979543f0f`  
> 分支：`fix/p0-sec-01-b01`  
> 契约：`docs/contracts/p0-sec-01-ac-v1.0.md`，21,297 bytes，  
> SHA-256 `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0`，未修改。

## 1. 结论摘要

B01 是确定性的容器启动/取消生命周期竞态：

- 旧版本在 `execution_resources` 中一登记就把资源当作已启动；
- 取消只查询 `started/running/stopping`，漏掉启动中的 `starting/intent`；
- `docker inspect` 在容器尚未创建时返回 `gone`，被当作安全停止；
- 取消因此提前返回 `ok=true`，随后被暂停的启动协程才真正调用 `docker run`，产生迟到容器启动。
- 执行容器、Verify 容器、Audit 容器三条路径都存在同一问题。

修复后：

- 资源生命周期区分 `intent → starting → started → running → stopped / abandoned / unknown`；
- 启动意图登记和 `starting→started` 转换都与任务取消状态原子绑定；
- 真正 `docker run` 之前有最后一道原子 guard；
- 使用 `--cidfile` + `onStarted` 确认容器实际创建，记录 `running`；
- 取消建立完成屏障：`intent` 直接 abandon；`starting/started/running/stopping` 必须等到 `stopped/abandoned`，或有真实 kill 证据；
- `docker inspect=gone` 在启动阶段不再视为安全停止；
- 超时、daemon 失联、启动结果不明 → `unknown` + `ok=false`，Fail Closed。

## 2. B01 修复前失败证据

### 2.1 固定旧版本（db135e3）+ 新测试

用独立 worktree 检出 `db135e3`，只放入新的 B01 测试：

```text
✖ B01-A 执行容器：取消已报告成功后不得迟到启动
  取消返回 ok=true 后仍观察到迟到启动
  (task=cancelled, result=cancelled)

✖ B01-B 验证容器：取消已报告成功后不得迟到启动
  取消返回 ok=true 后仍观察到验证容器迟到启动
  (task=cancelled)
```

结果：**2/2 失败**。

### 2.2 三场景复现（旧版）

修复前本机原始测试（执行 / 验证 / Audit）：

```text
✖ B01-A 执行容器：取消已报告成功后不得迟到启动
✖ B01-B 验证容器：取消已报告成功后不得迟到启动
✖ B01-C Audit 容器：取消已报告成功后不得迟到启动
```

结果：**3/3 失败**；原因均为取消 `ok=true` 后容器才迟到启动。

### 2.3 根因链

```text
registerResource() 直接写 state='started'
→ 取消查询只覆盖 started/running/stopping，漏掉启动中 intent/starting
→ 启动协程尚未调用 docker run
→ docker inspect 找不到容器，返回 confirmed=true,state='gone'
→ cancelTask 标记 execution/task cancelled 并返回 ok=true
→ 启动协程恢复，真正执行 docker run
→ 迟到容器启动
```

旧实现把“资源记录存在”当成了“容器已经启动”，又用“容器暂时不存在”证明“启动流程已安全消失”。

## 3. 修复内容

### 3.1 统一生命周期

`execution_resources.state` 新增语义：

| state | 含义 |
|---|---|
| `intent` | 启动意图已登记，尚未 claim |
| `starting` | 启动流程已 claim，尚未确认 docker 容器创建 |
| `started` | 已通过最后一道 docker 调用前检查，docker 调用可能发生 |
| `running` | `--cidfile` 出现，容器实际创建 |
| `stopping` | 取消/终止进行中 |
| `stopped` | 已确认容器不再运行 |
| `abandoned` | 已确认未启动/启动前被取消 |
| `unknown` | 无法确认 |

### 3.2 原子启动控制

- `registerContainerIntent()` 使用条件 INSERT：
  - 只有任务状态为 `running/verifying` 才登记 `intent`；
  - 任务已 `cancel_requested/cancelled` 时无法登记新启动意图。
- `claimContainerStart()`：
  - 原子 `intent → starting`，同时要求任务未取消。
- `claimDockerInvocation()`：
  - 在真正 `docker run` 前原子 `starting → started`，同时要求任务未取消；
  - 取消先到 → 转换失败，启动方 abandon，不调用 Docker。
- `runClaudeIsolated()` / `runInWorkdir()` 的 `guard` 在 `docker run` 前最后调用；
  - guard 失败返回 `{cancelled:true}`，不产生容器。
- `--cidfile` + `onStarted`：
  - 容器实际创建后写 `running`；
  - 取消方知道“启动确实发生过”，不会把 `gone` 当成启动前安全状态。

### 3.3 取消完成屏障

`cancelTask()` 使用短更新 + 轮询，不长期占用 SQLite 写事务：

- `intent`：原子 `abandoned`，确认未启动。
- `starting/started/running/stopping`：
  - 标记 `stopping`；
  - 轮询实际 `killContainer`，等待资源落 `stopped/abandoned`；
  - `docker inspect=gone` 不足以确认；必须等启动方或真实 kill 证据；
  - `docker kill` 被接受 + 容器 gone，才可作为终止证据；
  - daemon 失联/超时 → `unknown` + `ok=false`。
- PID 终止结果也纳入 `fullyStopped`，不再只看容器。
- 任务/Execution 只在所有资源 resolved 后标记 cancelled。
- 重复取消：已 cancelled 返回 `already_cancelled`，不改写终态；并发取消不创建新执行。

### 3.4 覆盖入口

同一个 `launchContainer()` 用于：

- `runExecutorTask()` 的 Claude Code 执行容器；
- 执行器 Verify 容器；
- `runAuditTask()` 的 Audit 容器。

没有只修 `runClaudeIsolated()` 而遗漏 `runInWorkdir()` 或审计入口。

## 4. B01 七项专项验收

| 编号 | 结果 | 证据 |
|---|---|---|
| B01-QA-01 取消先于执行启动 | PASS | B01-A：资源 `abandoned`，无迟到启动；旧版 3/3 失败 |
| B01-QA-02 取消发生于启动进行中 | PASS | B01-QA-02 + 真实 Docker：cancel 未在 barrier 释放前返回；实际 kill；无容器残留 |
| B01-QA-03 验证容器同样安全 | PASS | B01-B：verify 资源 `abandoned/stopped`，无迟到启动 |
| B01-QA-04 Audit 同样安全 | PASS | B01-C：audit 资源 `abandoned`，无迟到启动 |
| B01-QA-05 异常与重启 | PASS | B01-QA-05a daemon 失联 → unknown/ok=false；05b 遗留 `starting` → 超时 unknown，execution 保持 running |
| B01-QA-06 幂等/并发 | PASS | 重复取消 `already_cancelled`；并发取消不产生新 execution，终态 cancelled |
| B01-QA-07 合法正向执行 | PASS | 真实 Claude Code + Docker + GLM + SE 审批：Task done、Verify `FEATURE_OK`、Commit/Ref 正确 |

## 5. 真实 Docker 启动/取消竞态

脚本：`orchestrator/scripts/verify-b01-docker-race.mjs`

- Wrapper 在真实 `docker run` 前建立文件屏障；
- 真实容器镜像 `jarvis-b01-exec:test`（alpine + sleep 120）；
- 取消发生在启动屏障处，随后释放屏障，真实容器启动并被取消终止。

本机连续 2 次结果一致：

```json
{
  "taskStatus": "cancelled",
  "cancelOk": true,
  "cancelResolvedBeforeRelease": false,
  "executionStatus": "cancelled",
  "resourceState": "stopped",
  "sawContainerRunning": true,
  "containerPs": "",
  "image": "jarvis-b01-exec:test"
}
```

含义：

- 取消未在 docker run 释放前返回成功；
- 真实容器确实启动过（`sawContainerRunning=true`）；
- 取消后容器被终止，`docker ps -a` 无残留；
- Task/Execution/Resource 状态一致。

## 6. 真实正向执行（B01-QA-07）

真实 Claude Code + Docker + GLM + 生产 Secure Enclave 审批：

```json
{
  "task": "tsk_mvxamaku03184v",
  "approvalExecutionId": "exe_mvxamdcf07yh05",
  "executionId": "exe_mvxamdcf07yh05",
  "executionStatus": "ok",
  "taskStatus": "done",
  "commitSha": "1ca2d4c72e38d88e1e1007b49f3887fc7adc79b2",
  "refVerified": true,
  "changed": ["feature.txt"],
  "verify": { "exitCode": 0, "output": "FEATURE_OK\n" }
}
```

资源状态：

```text
claude  stopped
verify  stopped
token file {}
```

## 7. 状态一致性证据

| 场景 | Task | Execution | Resource | Docker | Git |
|---|---|---|---|---|---|
| 真实启动中取消 | cancelled | cancelled | stopped | 无残留 | 无 Commit |
| 启动前取消（执行） | cancelled | cancelled | abandoned | 未启动 | HEAD 不变 |
| 启动前取消（Verify） | cancelled | cancelled | verify abandoned | 未启动 | 无 Commit |
| 启动前取消（Audit） | cancelled | cancelled | audit abandoned | 未启动 | 无 Commit |
| 遗留 starting + 超时 | cancel_requested | running | unknown | 无法确认 | 不变 |
| 合法正向 | done | ok | claude/verify stopped | 容器正常退出 | Commit/Ref 验证 |

## 8. 测试与 CI

本机（macOS 15.6.1 / M4 / Docker 29.9.2）：

```text
node --test orchestrator/test/*.test.mjs
tests 96 / pass 96 / fail 0 / skipped 0
```

其他真实环境：

```text
verify-b01-docker-race.mjs   2/2 PASS（连续）
verify-cancel-sigkill.mjs    6/6 PASS
Docker isolation tests       2/2 PASS
```

GitHub Actions（实现 Commit `f2a3f9d`）：

- Run: https://github.com/bojing951-hash/jarvis-coding/actions/runs/41271282182
- `unit + fault-injection` success
- `contract integrity` success
- Node v24.22.1

```text
tests 96 / pass 93 / fail 0 / cancelled 0 / skipped 3
```

3 个 skip 全部是 CI 无执行器镜像的显式 Docker skip：

- Docker 验证容器实际执行；
- Docker 审计/验证只读挂载；
- FIX3-D 只读挂载。

本机已用真实 Docker 执行通过；不以 CI skip 冒充 PASS。

## 9. 修复后代码位置

- `orchestrator/src/service.mjs`
  - `execution_resources` 生命周期
  - `registerContainerIntent` / `claimContainerStart` / `claimDockerInvocation`
  - `launchContainer`
  - `settleCancelResource`
  - `cancelTask` 完成屏障
- `orchestrator/src/isolation.mjs`
  - `guard`
  - `--cidfile` + `onStarted`
  - `killAccepted` 证据
- `orchestrator/test/b01.test.mjs`
- `orchestrator/scripts/verify-b01-docker-race.mjs`
- `orchestrator/test/fix3-close.test.mjs`（取消前测试适配新屏障，不弱化断言）

完整 Diff：`docs/21-b01.diff`（`db135e3..f2a3f9d`，1,206 行）。

## 10. 已知限制

1. CI 不执行真实 Docker；3 个显式 skip 已披露，本机真实证据已提供。
2. `--cidfile` 的 `onStarted` 检测窗口为 5 秒；若容器创建但回调未触发，资源保持 `started`，取消会 Fail Closed（可能返回未确认），不会虚报成功。
3. 启动屏障等待上限 15 秒；Docker API 极慢时返回 `unknown`，需要人工核查。
4. Orchestrator 在 `starting` 状态崩溃后，后续取消会超时 → `unknown`，不会自动当作安全停止。
5. `docker kill` 被接受 + gone 才作为终止证据；若容器先自然退出且 kill 被拒绝，取消返回未确认（Fail Closed）。
6. 真实 Audit 容器未重跑模型调用；Audit 生命周期用同一 `launchContainer` 路径的 B01-C 测试 + 真实只读挂载测试覆盖。
7. 旧版真实 Docker 旧代码未重复执行（会留下迟到容器）；旧版失败由固定 `db135e3` 服务层测试 + 真实 SQLite/git + 假容器屏障证明。

## 11. 原 22 AC 仍缺少的真实验收证据

本轮不扩大范围，以下项沿用 FIX3-CLOSE 报告的 PARTIAL 状态，不因 B01 修复自动变成 PASS：

- AC-02 / AC-08：未重新跑真实 MCP/Workflow 会话；
- AC-20：未实测“提交中断后自动恢复”；
- AC-22：未重新跑真实 OpenClaw 非编程工作流；
- E2E-01 / E2E-08 / E2E-10：对应 live 证据仍为 PARTIAL。

B01 直接覆盖 AC-17、AC-18、AC-21 和 E2E-07 的取消/生命周期部分；最终 AC 裁决仍由 Agent 2 独立完成。

## 12. 门禁与回滚

| 门禁 | 状态 |
|---|---|
| G0 开发准备 | 通过 |
| G1 失败复现/定向修复 | 通过 |
| G2 自动质量 | 通过（96 项本机、CI 96/93/3、真实 Docker、真实正向 E2E） |
| G3 独立验收 | 未开始 |
| 正式 PASS | **未宣布** |

**本工作包：`READY_FOR_INDEPENDENT_AUDIT`。**

回滚：

```bash
git checkout fix/p0-sec-01-b01
git reset --hard db135e3

# 清理 B01 专用测试镜像
docker rmi jarvis-b01-exec:test
```

不修改 `main`，不合并 main。
