# 22 · P0-SEC-01-FIX3-CLOSE-B02 开发与证据报告

> 状态：**DEVELOPMENT_DELIVERED / READY_FOR_INDEPENDENT_AUDIT**  
> 不宣布正式验收 PASS。G3 独立验收未开始。  
> 修复起点：`d4d87957798b52ba9a70cd4279319918f82d1e7f`  
> G0 补充契约 Commit：`2bc35b80ee7453a3fc22689414f5bf11b1595a87`  
> 实现目标 Commit：`ddfd47baf07c1e4ff869c658442afcf36a5b62e8`  
> 分支：`fix/p0-sec-01-b02`

## 1. 固定输入与 G0

| 项 | 值 |
|---|---|
| 仓库 | `bojing951-hash/jarvis-coding` |
| 起点 | `d4d8795`（B01 最终 HEAD） |
| 分支 | `fix/p0-sec-01-b02` |
| 原冻结契约 | `docs/contracts/p0-sec-01-ac-v1.0.md` |
| 原契约 SHA-256 | `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0` |
| 原契约规模 | 21,297 bytes；AC-01～22 / E2E-01～10 / EV-01～15 |
| B02 补充契约 | `docs/contracts/p0-sec-01-b02-qa-v1.0.md` |
| B02 契约 SHA-256 | `6078386fc3554813956bf8e7f38d5ccaa324c65d03fc1ae9871088cb2c10d940` |
| B02 契约字节数 | 8,393 bytes |
| B02 契约冻结 Commit | `2bc35b8`（在代码修改前单独提交） |
| Node（本机） | v24.13.1 |
| Docker | 29.9.2 |
| macOS | 15.6.1 / Apple M4 |
| 测试镜像 | `jarvis-executor:2.1.104`、`jarvis-b01-exec:test` |

G0 已完成：

- 从 `d4d8795` 创建独立分支；
- 核对原契约 SHA；
- 检查 Node/Docker/macOS/镜像；
- 先提交 B02 冻结补充契约，再开始代码修改；
- `main`、原契约、B02 契约均未在开发中修改。

## 2. DEF-01 根因与修复前失败

### 2.1 根因

`orchestrator/src/isolation.mjs` 旧实现：

```js
resolve({ code: err?.code ?? 0, out: ... })
```

`execFile()` 在 timeout / signal / spawn error 时可能返回 `err.code = null`，旧实现把它转成 `code = 0`，于是：

- Docker daemon info 超时被当成健康；
- Claude/Verify/Audit CLI 被信号终止或超时被当成 `ok=true`；
- `docker kill` 超时被当成 `killAccepted=true`；
- `docker run` CLI 超时后资源被写成 `stopped`；
- Task/Execution 可能错误进入 done/ok 或错误确认取消。

### 2.2 修复前实测

固定旧代码 `d4d8795`（只增加 G0 契约，不加代码修复）运行 B02 测试：

```text
tests 9 / pass 1 / fail 8
```

失败项：

- B02-QA-01 timeout / signal；
- B02-QA-02 Claude CLI 信号 → Task `done`；
- B02-QA-02 Verify 信号 → Task `done`；
- B02-QA-02 Audit 信号 → Task `done`；
- B02-QA-03 signal kill → `killAccepted=true, confirmed=true`；
- B02-QA-04 info 信号 → daemon 被判健康；
- B02-QA-05 超时结果 → 资源被写成 `stopped`。

旧版真实输出示例：

```text
✖ B02-QA-01 真实 execFile 信号终止不得返回成功
  {"ok":true,"exitCode":0,...}
✖ B02-QA-02 Claude CLI 信号不得让 Task 变成 done
  {"task":"done"}
✖ B02-QA-03 信号终止的 docker kill 不得产生 killAccepted/confirmed
  {"ok":true,"confirmed":true,"state":"gone","killAccepted":true}
✖ B02-QA-05 launchContainer 超时结果不得写 stopped
  resource.state: stopped
```

## 3. 修复内容

### 3.1 `sh()` 标准化

`export const sh()` 现在返回：

```js
{
  ok, code, errorCode, signal, killed, timedOut, abnormal, error, out
}
```

- 只有 `err == null` 才 `ok=true, code=0`。
- 非零退出：`ok=false`，保留数字 `code`，`abnormal=false`。
- timeout：`ok=false, code=null, timedOut=true, killed=true, abnormal=true`。
- 外部信号：`ok=false, code=null, signal=SIGTERM/SIGKILL, timedOut=false, abnormal=true`。
- ENOENT：`ok=false, code=null, errorCode='ENOENT', abnormal=true`。
- maxBuffer：`ok=false, code=null, errorCode='ERR_CHILD_PROCESS_STDIO_MAXBUFFER', abnormal=true`。

### 3.2 Docker 结果与终止证明

- `isolationStatus()` / `daemonReachable()` 只在 `ok && code===0` 时认为成功；info 超时/信号/空输出都 Fail Closed。
- `runClaudeIsolated()` / `runInWorkdir()` 返回 `ok/code/signal/killed/timedOut/abnormal/cliError`。
- `killAccepted` 只能来自 `kill` 命令 `ok=true`；timeout/signal/非零退出不能产生。
- `killContainer()`：
  - `inspect=gone` + 不可信 kill → `confirmed=false`；
  - `inspect=exited/dead/removing` 是独立可信停止证据，可以 `confirmed=true`；
  - kill 成功但容器仍 running → 继续等待/升级；不确认停止。
- `settleCancelResource()` 只接受：
  - `stopped/abandoned` 且停止证据可信；
  - 或真实 `exited/dead/removing`；
  - 或 kill 被接受后的 gone。
- 无 `execution_resources` 的历史执行走同一 `killContainer()` 证明规则，不绕过。

### 3.3 资源终态

`launchContainer()`：

- 适配层正常返回（包括容器正常非零退出）→ 资源可 `stopped`；
- `abnormal/timedOut/signal/killed/cliError` → `unknown`，不伪造 stopped；
- 适配层抛异常 → `unknown`；
- guard 取消 → `abandoned`。

`Docker CLI 结束 ≠ 容器已停止` 已被编码到状态判断中。

### 3.4 真实 Docker 证据脚本

`orchestrator/scripts/verify-b01-docker-race.mjs` 已修正：

- 唯一 `mkdtemp` 测试目录，不清理非本测试资源；
- Execution ID 从 SQLite `executions.status=running` 读取，不从 `result.execution` 猜；
- 容器名从 resource 行取得，并校验 `jarvis-exec-<executionId>`；
- 记录 container ID、inspect 状态序列、正确名称的 `docker ps -a`；
- 记录 Git HEAD 前后；
- 失败时 `docker rm -f` 仅清理本测试容器，保留日志/临时根目录。

## 4. B02-QA-01～10 逐项结果

| 编号 | 状态 | 证据 |
|---|---|---|
| B02-QA-01 子进程错误语义 | **PASS** | 21 项 B02 测试；normal/nonzero/timeout/signal/ENOENT/maxBuffer；旧版 8/9 失败 |
| B02-QA-02 Claude/Verify/Audit 完整性 | **PASS** | 三类异常均 Task failed / Execution failed；旧版 Task done；真实正向 E2E 仍 done |
| B02-QA-03 TERM/KILL 假证明 | **PASS** | kill signal/timeout → `killAccepted=false, confirmed=false`；exited 独立证据 → confirmed true；SIGKILL 6/6 |
| B02-QA-04 daemon/未知状态 | **PASS** | info signal/timeout false；inspect gone + 不可信 kill false；无 resources 历史路径 false；unknown Fail Closed |
| B02-QA-05 资源终态一致性 | **PASS** | timeout/throw → unknown；正常非零退出 → stopped + Task failed；正向资源 stopped |
| B02-QA-06 真实 Docker 竞态/残留 | **PASS** | 真实 created→running→gone；容器 ID/Execution 对应；ps 空；Git HEAD 不变 |
| B02-QA-07 合法终止/SIGKILL | **PASS** | SIGKILL 6/6（5.8s）；TERM 正常取消；重复取消 already_cancelled |
| B02-QA-08 真实正向执行 | **PASS** | 真实 Claude/GLM/SE：Task done、Verify FEATURE_OK、Commit/Ref、资源 stopped、token 空 |
| B02-QA-09 旧失败/新通过/CI | **PASS** | 旧版 8/9 fail；新版 21/21；全量 117/117；CI 117/114/3；两份契约未变 |
| B02-QA-10 完整 P0 继承 | **PASS（映射完整，审计方裁决）** | 见第 8 节；未用 Mock 替代真实 Mac/Docker E2E；未声明正式 PASS |

## 5. 真实 Docker 竞态证据（B02-QA-06）

最终一次运行：

```json
{
  "executionId": "exe_mvxchtvm05f3v2",
  "executionIdSource": "sqlite executions.status=running at docker barrier",
  "executionStatus": "cancelled",
  "resourceState": "stopped",
  "containerName": "jarvis-exec-exe_mvxchtvm05f3v2",
  "containerId": "75517f3d34c1deae51af1afdf91234514971c86a64a685270c121be575526b68",
  "containerNameMatchesExecution": true,
  "sawContainerRunning": true,
  "observedStates": ["running", "removing"],
  "inspectAfter": "gone",
  "cancelOk": true,
  "cancelResolvedBeforeRelease": false,
  "taskStatus": "cancelled",
  "executionStatus": "cancelled",
  "containerPs": "",
  "gitHeadBefore": "a520200ade4b6d461e4a78973be199cd60fa6270",
  "gitHeadAfter": "a520200ade4b6d461e4a78973be199cd60fa6270"
}
```

关键结论：

- 取消没有在屏障释放前返回；
- 容器实际创建并运行（container ID 非空，`sawContainerRunning=true`）；
- 容器名与 Execution 精确对应；
- 取消后 inspect gone、`ps` 空；
- Git HEAD 不变；
- Task/Execution/Resource 状态一致。

测试镜像构建：

```bash
docker build -t jarvis-b01-exec:test /tmp/jarvis-b01-image
```

## 6. 合法正向执行（B02-QA-08）

真实 Claude Code + Docker + GLM + 生产 Secure Enclave 审批：

```json
{
  "task": "tsk_mvxcezj503g0ek",
  "approvalExecutionId": "exe_mvxcfem507thhe",
  "executionId": "exe_mvxcfem507thhe",
  "executionStatus": "ok",
  "taskStatus": "done",
  "commitSha": "2011f26991a7346d52f72bba90d446d834a300ac",
  "refVerified": true,
  "changed": ["feature.txt"],
  "verify": { "exitCode": 0, "output": "FEATURE_OK\n" }
}
```

资源与清理：

```text
claude  stopped
verify  stopped
token file {}
```

## 7. B01-QA-01～07 回归

| B01 项 | B02 回归结果 |
|---|---|
| QA-01 取消先于执行启动 | PASS（B01-A 仍通过） |
| QA-02 启动进行中取消 | PASS（B02 真实 Docker 竞态） |
| QA-03 Verify 同样安全 | PASS（B01-B 仍通过） |
| QA-04 Audit 同样安全 | PASS（B01-C 仍通过） |
| QA-05 异常与重启 | PASS（B02-QA-04/05） |
| QA-06 幂等/并发 | PASS（B01-QA-06、重复取消） |
| QA-07 合法正向 | PASS（真实 Claude E2E） |

## 8. AC / E2E / EV 完整映射

状态：`PASS` 有本轮直接证据；`PARTIAL` 有代码/单元/回归但缺少 live 层；`WAITING` 需真实环境补证。**开发方不宣布正式 PASS。**

### 22 AC

| AC | 状态 | 证据 |
|---|---|---|
| AC-01 固定版本/范围 | PASS | 起点 d4d8795、G0 2bc35b8、目标 ddfd47b、main 未改 |
| AC-02 MCP 无未授权 Shell | PARTIAL | 配置/注入测试；未重跑 live MCP |
| AC-03 命令注入防护 | PASS | security.test AC-01/AC-08 |
| AC-04 可信验证配置 | PASS | 签名登记 + 配置测试 |
| AC-05 真实人工审批 | PASS | 生产 SE 签名 + 真实审批 E2E |
| AC-06 审批内容绑定 | PASS | digest/profile 测试 |
| AC-07 审批过期/重放 | PASS | 挑战/审批复用测试 |
| AC-08 全入口共用门禁 | PARTIAL | 配置/工作流测试；未 live MCP |
| AC-09 项目目录限制 | PASS | AC-04 路径测试 |
| AC-10 路径穿越/符号链接 | PASS | AC-10 测试 |
| AC-11 外部执行器限制 | PASS | 真实 Docker + risk01 |
| AC-12 合法写入正向 | PASS | 真实 Claude E2E |
| AC-13 测试失败阻止 Commit | PASS | AC-13 真 git 测试 |
| AC-14 缺少校验不得提交 | PASS | AC-14 测试 |
| AC-15 提交范围 | PASS | AC-05 提交范围测试 |
| AC-16 成功提交真实证据 | PASS | 真实 Commit/Ref |
| AC-17 取消后无副作用 | PASS | B02 真实 Docker + B01 测试 |
| AC-18 取消失败不虚报 | PASS | B02 TERM/KILL/daemon 测试 + SIGKILL |
| AC-19 并发/重复 | PASS | B01 并发/审批归属 |
| AC-20 暂停/失败/重启 | PARTIAL | 重启终态 6/6；未实测提交中断自动恢复 |
| AC-21 执行证据完整 | PASS | B02 资源/Execution/SQLite 证据 |
| AC-22 无阻断回归 | PARTIAL | 117 项套件；未重跑 live OpenClaw 非编程工作流 |

### 10 E2E

| E2E | 状态 | 证据 |
|---|---|---|
| E2E-01 未授权 Shell 拒绝 | PARTIAL | 单元/配置；未 live MCP |
| E2E-02 伪造审批拒绝 | PASS | PRE-A02 |
| E2E-03 真实审批后合法执行 | PASS | 真实 Claude E2E |
| E2E-04 测试失败阻断提交 | PASS | AC-13 |
| E2E-05 无关文件不进 Commit | PASS | AC-15 |
| E2E-06 跨项目/路径逃逸 | PASS | AC-04/AC-10 |
| E2E-07 取消竞态 | PASS | B02 真实 Docker + B01 |
| E2E-08 Workflow 权限绕过 | PARTIAL | 配置测试；未 live workflow |
| E2E-09 审批绑定/重放 | PASS | PRE-A03/挑战测试 |
| E2E-10 非编程工作流回归 | PARTIAL | smoke/单元；未 live OpenClaw |

### 15 EV

| EV | 证据 |
|---|---|
| EV-01 固定基线/目标 | 本报告第 1 节 + G0 Commit |
| EV-02 完整 Diff | `docs/22-b02.diff` |
| EV-03 修改文件清单 | 本报告第 9 节 |
| EV-04 安全执行调用链 | 报告第 2–3 节 + 源码 |
| EV-05 审批机制/可信来源 | FIX3-CLOSE 报告 + 第 8 节 |
| EV-06 Shell 注入负向 | security.test AC-01/AC-08 |
| EV-07 未授权写入负向 | PRE-A02/AC-02 |
| EV-08 跨项目/路径逃逸 | AC-04/AC-10 |
| EV-09 测试失败阻断 Commit | AC-13 |
| EV-10 合法执行/验证/Commit | 第 6 节真实 E2E |
| EV-11 Git 提交范围 | AC-15 |
| EV-12 取消/并发竞态 | 第 4–7 节 + 真实 Docker |
| EV-13 原有功能回归 | 本机 117/117、CI 117/114/3 |
| EV-14 执行状态/审计记录 | SQLite + 真实 Docker 证据 |
| EV-15 环境限制/风险/回滚 | 第 10–11 节 |

## 9. 修改文件与 Diff

```text
docs/contracts/p0-sec-01-b02-qa-v1.0.md   （G0 冻结，303 行）
orchestrator/src/isolation.mjs
orchestrator/src/service.mjs
orchestrator/test/b02-timeout.test.mjs
orchestrator/scripts/verify-b01-docker-race.mjs
```

完整 Diff：`docs/22-b02.diff`（`d4d8795..ddfd47b`，1,207 行）。

## 10. 测试与 CI

本机：

```text
node --test orchestrator/test/*.test.mjs
tests 117 / pass 117 / fail 0 / skipped 0
```

B02 专项：21/21 PASS。  
B01 专项：7/7 PASS。  
SIGKILL：6/6 PASS（5.8s）。  
Docker isolation：2/2 PASS。

GitHub Actions：

- 实现 Commit `ddfd47b`：https://github.com/bojing951-hash/jarvis-coding/actions/runs/41274491784
- `unit + fault-injection` success
- `contract integrity` success
- Node v24.22.1

```text
tests 117 / pass 114 / fail 0 / cancelled 0 / skipped 3
```

3 个 skip 全部是 CI 无执行器镜像的显式 Docker skip：

- Docker 验证容器实际执行；
- Docker 审计/验证只读挂载；
- FIX3-D 只读挂载。

本机已真实执行；不以 skip 冒充 PASS。

## 11. 未验证事项、风险与回滚

### 未验证 / WAITING

1. AC-02/AC-08/E2E-01/E2E-08：未重跑 live MCP/Workflow。
2. AC-20：未实测“提交中断后自动恢复”。
3. AC-22/E2E-10：未重跑 live OpenClaw 非编程工作流。
4. 真实 Audit 模型调用未重跑；Audit 生命周期由 B01-C + 真实只读挂载测试覆盖。
5. 旧版真实 Docker 未重复执行（会留下迟到容器）；旧版失败由固定 d4d8795 + 真实 SQLite/Git + 受控 Docker CLI 注入证明。

### 风险

- CI 不执行真实 Docker；3 个 skip 已披露。
- `--cidfile` 检测窗口 5 秒；未命中时 Fail Closed。
- 启动屏障等待上限 15 秒；Docker API 极慢 → unknown。
- `killAccepted` 依赖 `docker kill` 成功返回；容器自然退出且 kill 被拒绝时返回未确认。
- Orchestrator 在 starting 状态崩溃 → unknown，不会自动视为停止。
- 真实 Docker 测试依赖本机镜像/daemon；不可用时脚本退出 2，不会伪造 PASS。

### 回滚

```bash
git checkout fix/p0-sec-01-b02
git reset --hard d4d8795
docker rmi jarvis-b01-exec:test
```

G0 补充契约 `docs/contracts/p0-sec-01-b02-qa-v1.0.md` 不得在开发中修改；回滚会一并移除。

## 12. 门禁结论

| 门禁 | 状态 |
|---|---|
| G0 开发准备/契约冻结 | 通过（2bc35b8） |
| G1 旧失败/新通过 | 通过（旧版 8/9 fail，新版 21/21 pass） |
| G2 自动质量 | 通过（117/117 本机；CI 117/114/3；真实 Docker/Mac） |
| G3 独立验收 | 未开始 |
| 正式 PASS | **未宣布** |

**本工作包：`READY_FOR_INDEPENDENT_AUDIT`。**

开发方不自行宣布正式 PASS；B02-QA-10 映射中的 PARTIAL/WAITING 项由 Agent 2 独立裁决。
