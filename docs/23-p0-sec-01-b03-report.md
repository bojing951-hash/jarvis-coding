# 23 · P0-SEC-01-FIX3-CLOSE-B03 开发与证据报告

> 状态：**DEVELOPMENT_DELIVERED / READY_FOR_INDEPENDENT_AUDIT**  
> 不宣布正式验收 PASS。G3 独立验收未开始。  
> 固定开发基线：`f5252766e6c06a219d0f933e69cbefaaec739374`  
> G0 补充契约 Commit：`9e837435df60f95c807b08acbdc5ff9150e574dd`  
> 实现目标 Commit：`3f5e5acca320ee6ce50aebd705e8f609b8dd3b29`  
> 分支：`fix/p0-sec-01-b03`

## 1. 固定输入与 G0

| 项 | 值 |
|---|---|
| 仓库 | `bojing951-hash/jarvis-coding` |
| 固定基线 | `f5252766e6c06a219d0f933e69cbefaaec739374`（B02 最终 HEAD） |
| 分支 | `fix/p0-sec-01-b03` |
| 原冻结契约 | `docs/contracts/p0-sec-01-ac-v1.0.md` |
| 原契约 SHA-256 | `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0` |
| 原契约规模 | 21,297 bytes；AC-01～22 / E2E-01～10 / EV-01～15 |
| B02 冻结契约 | `docs/contracts/p0-sec-01-b02-qa-v1.0.md` |
| B02 契约 SHA-256 | `6078386fc3554813956bf8e7f38d5ccaa324c65d03fc1ae9871088cb2c10d940` |
| B03 冻结契约 | `docs/contracts/p0-sec-01-b03-qa-v1.0.md` |
| B03 契约 SHA-256 | `27c0d284508e177c25188453dd5e79a912a2e83d94dc4a24fd26847486e0ca6b` |
| B03 契约字节数 | 8,979 bytes；B03-QA-01～09 |
| B03 冻结 Commit | `9e83743`（代码修改前单独提交） |
| Node（本机） | v24.13.1 |
| Docker | 29.9.2 |
| macOS | 15.6.1 / Apple M4 |

G0 已完成：固定基线核对、三份契约哈希核对、Node/Docker/macOS/镜像检查、独立分支创建、B03 契约先冻结后开发。`main`、原契约、B02 契约、B03 契约在开发中均未修改。

## 2. 两项审计缺陷的旧版复现

### 2.1 DEF-01：inspect 异常输出被当作 gone

旧实现 `inspectState()`：

```js
const r = await sh(...inspect...);
if (r.ok) return { kind: 'state', value: r.out.trim() };
if (/No such object|could not be found/i.test(r.out)) return { kind: 'gone' };
```

`sh()` 在 timeout / signal 时 `r.ok=false`，但 `r.out` 可能已经包含 `No such object`。旧代码不区分“正常完成的非零退出”与“异常结束”，于是：

```text
inspect 输出 No such object → 随后 timeout/signal
→ inspectState() 返回 gone
→ killContainer() 返回 confirmed=true
```

在固定基线 `f525276` 上运行 B03 定向测试：

```text
tests 13 / pass 9 / fail 4
```

失败项：

```text
✖ No such object 后超时不得 confirmed
  {"ok":true,"confirmed":true,"state":"gone","killAccepted":true}

✖ No such object 后被信号终止不得 confirmed
  {"ok":true,"confirmed":true,"state":"gone","killAccepted":true}

✖ 不匹配目标容器的 No such object 不得 confirmed
  {"ok":true,"confirmed":true,"state":"gone","killAccepted":true}

✖ KILL 后 inspect 仍异常不得 confirmed
  {"ok":true,"confirmed":true,"state":"gone","killAccepted":true}
```

### 2.2 EV-01：旧验证器把 Docker 查询失败当作成功

旧验证器的最终判定只检查 `containerPs.length === 0`；`docker ps` 抛错时被 `catch {}` 吞掉，`containerPs` 保持空字符串。

使用固定基线脚本、将 `docker ps` 强制为退出 1：

```bash
JARVIS_DOCKER_BIN_REAL=/tmp/ps-fail-docker.sh \
DOCKER_HOST=unix:///Users/cast/.docker/run/docker.sock \
node orchestrator/scripts/verify-b01-docker-race.mjs
```

旧结果：

```text
containerPs: ""
containerId: "aa01a6a0729d..."
taskStatus: cancelled
exit 0
```

即：`docker ps` 失败仍 PASS。旧脚本还：

- 将 `inspect` 查询异常 `catch` 成 `"gone"`；
- 计算了 `inspectAfter`，但没有纳入最终成功条件；
- 没有采集 create/start/die/destroy 生命周期事件；
- 没有验证 `docker ps` 查询本身是否正常完成。

## 3. 修复内容

### 3.1 `inspectState()` 三类结果

`orchestrator/src/isolation.mjs` 现在明确区分：

**A. 正常完成**

- `r.ok=true`：只使用 `stdout` 作为状态。
- 正常非零退出：保留 `code`、`stdout`、`stderr`，只有同时满足以下条件才识别 `gone`：
  - `r.abnormal=false`；
  - 退出码为正常数字；
  - 错误文本明确匹配 `No such object` / `No such container`；
  - 错误文本中的目标容器名与本次 `name` 精确匹配。

**B. 异常结束**

- timeout；
- signal；
- killed；
- spawn error；
- maxBuffer；
- 其他 `abnormal`。

**无论 stdout/stderr 中出现什么文字，一律返回 `error`，不产生 gone/daemon/停止证明。**

**C. 完成但无法识别**

- 未知状态；
- 无法识别的错误文本；
- 目标不匹配的错误文本；
- 异常格式。

返回 `unknown/error`，由 `killContainer()` 继续 Fail Closed。

`sh()` 现在保留独立的 `stdout` 与 `stderr`，不再把两者混合后直接做正则匹配。

### 3.2 终止证明链

- `killAccepted` 只来自 kill 命令 `ok=true`。
- `inspect=gone` 只有在“查询正常完成 + 明确目标不存在”时才可信。
- `exited/dead/removing` 是独立可信停止证据，可确认停止。
- kill 成功但 inspect 仍 running → 不确认停止。
- kill 失败但 inspect 有独立可信停止证据 → 可确认停止。
- kill 成功但 inspect 超时/异常 → 不确认停止。
- daemon 失联 → 不确认停止。
- `settleCancelResource()` / `cancelTask()` 继承同一未确认语义。

### 3.3 验证器共用判定

新增：

```text
orchestrator/scripts/b03-docker-evidence.mjs
```

导出：

- `evaluateDockerRaceEvidence(evidence)`；
- `isTrustedGoneInspect(result, containerName)`。

`verify-b01-docker-race.mjs` 与实际反向测试都调用同一个判定函数，不复制最终布尔表达式。

验证器现在要求：

- `ps.ok === true` 且 `ps.stdout` 为空；
- 最终 `inspect` 正常完成并可信 gone/exited/dead/removing；
- 真实 Docker events `create/start/die/destroy` 完整；
- `eventsOk === true`；
- Execution ID、容器名、容器 ID 一致；
- 取消未提前确认；
- Task/Execution/Resource 状态一致；
- Git HEAD 未变化。

任何关键查询失败都返回 FAIL，不得以空字符串/默认值制造成功。

## 4. B03-QA-01～09 逐项结果

| 编号 | 状态 | 证据 |
|---|---|---|
| B03-QA-01 inspect 异常不得成为可信事实 | **PASS** | 14/14 定向测试；旧版 4/13 失败；正常 No such 可识别，异常 No such 一律不可信 |
| B03-QA-02 正常 Docker 停止语义不回归 | **PASS** | exited/dead/removing；TERM 失败+exited；kill 成功+running 不确认；SIGKILL 6/6 |
| B03-QA-03 终止证明沿完整调用链传播 | **PASS** | 真实 `killContainer→settleCancelResource→cancelTask` 链；不可信 inspect → cancel=false、Task cancel_requested、Execution running、Resource unknown |
| B03-QA-04 真实 Docker 生命周期证据完整 | **PASS** | create/start/die/destroy 事件、container ID、inspect、ps、SQLite、Git HEAD 全部一致 |
| B03-QA-05 真实验证器能检测自身失败 | **PASS** | 20 项反向测试；旧脚本 ps 失败 exit 0，新脚本同条件 exit 1；events 查询失败也 FAIL |
| B03-QA-06 旧版失败与新版通过 | **PASS** | 旧版 inspect 4/13 fail、旧验证器 ps 失败仍 PASS；新版 14/14、同条件 exit 1 |
| B03-QA-07 完整安全回归与 CI | **PASS** | 151/151 本机；SIGKILL 6/6；Docker isolation 2/2；CI 151/148/3；三份契约未变 |
| B03-QA-08 真实合法执行不回归 | **PASS** | 真实 Claude/GLM/SE：Task done、Verify FEATURE_OK、Commit/Ref、资源 stopped、token 空 |
| B03-QA-09 完整冻结契约继承与审计证据 | **PASS（映射完整）** | 第 8 节完整映射；明确真实/模拟/CI/WAITING 边界；未宣布正式 PASS |

## 5. 真实 Docker 生命周期证据

最终两次正常运行均通过共用验证器。以其中一次为例：

```json
{
  "executionId": "exe_mvxg4w9f057ber",
  "executionIdSource": "sqlite executions.status=running at docker barrier",
  "executionStatus": "cancelled",
  "resourceState": "stopped",
  "containerName": "jarvis-exec-exe_mvxg4w9f057ber",
  "containerId": "59367e87f9a2de09f4bf342ca8f874b847c71638e408100a8bd80a42cdded2ea",
  "containerNameMatchesExecution": true,
  "sawContainerRunning": true,
  "observedStates": ["created", "running", "removing"],
  "events": ["create", "start", "die", "destroy"],
  "eventsOk": true,
  "ps": {
    "ok": true,
    "status": 0,
    "stdout": "",
    "stderr": ""
  },
  "inspectAfter": {
    "ok": false,
    "status": 1,
    "stderr": "error: no such object: jarvis-exec-exe_mvxg4w9f057ber\n",
    "abnormal": false,
    "trustedGone": true
  },
  "cancelOk": true,
  "cancelResolvedBeforeRelease": false,
  "taskStatus": "cancelled",
  "gitHeadBefore": "759f903f9ccb2671b584a7fbc5adc6ea9b2d65dc",
  "gitHeadAfter": "759f903f9ccb2671b584a7fbc5adc6ea9b2d65dc",
  "validation": { "ok": true, "failures": [] }
}
```

测试使用唯一 `mkdtemp` 目录；容器名由 Execution ID 派生；events 通过带 `--since/--until/--filter container=<name>` 的 Docker 历史事件查询取得；失败清理只作用于本测试容器。

## 6. 验证器反向注入

`orchestrator/test/b03-validator.test.mjs` 直接调用共用 `evaluateDockerRaceEvidence()`，覆盖：

- `docker ps` 非零退出；
- `docker ps` 超时（同属 `ps.ok=false`）；
- 最终 inspect running；
- 最终 inspect 异常/无法确认；
- 缺少 create；
- 缺少 destroy；
- events 查询失败但部分输出含全部动作；
- 容器名与 Execution 不一致；
- 缺少 Execution ID；
- 缺少容器 ID；
- Task cancelled 但 Docker 仍运行；
- Git HEAD 变化；
- 取消提前确认；
- cancelTask 未成功；
- 资源状态 unknown；
- 未观察到容器运行。

结果：20/20 PASS。

端到端注入：

| 条件 | 旧脚本 | 新脚本 |
|---|---|---|
| `docker ps` 强制退出 1 | **exit 0（假阳性）** | **exit 1，failure: docker ps command failed** |
| 正常真实 Docker 竞态 | — | exit 0，validation.ok=true |

旧脚本日志：`containerPs: ""`、exit 0；新脚本日志：`ps.ok=false`、`validation.ok=false`、exit 1。

## 7. B02 / B01 回归

### B02-QA-01～10

B02 的 21 项测试全部保留并通过：

- sh 错误语义；
- Claude/Verify/Audit 异常；
- kill timeout/signal；
- daemon/inspect 超时；
- 资源终态；
- 真实 Docker 竞态；
- SIGKILL；
- 真实正向；
- 旧/新/CI。

### B01-QA-01～07

B01 的 7 项竞态测试全部保留并通过；真实 Docker 竞态、SIGKILL、正向 E2E 均未回归。

B02 的 fake Docker `inspect` 输出已改为包含目标容器名，以匹配新的身份校验；这是测试夹具修正，不 weakening 任何断言。

## 8. AC / E2E / EV 完整映射

状态：`PASS` 有直接证据；`PARTIAL` 有代码/单元/回归但缺少 live 层；`WAITING` 需真实环境补证。开发方不宣布正式 PASS。

### 22 AC

| AC | 状态 | 证据 |
|---|---|---|
| AC-01 固定版本/范围 | PASS | 基线 f525276、G0 9e83743、目标 3f5e5ac、main 未改 |
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
| AC-17 取消后无副作用 | PASS | B03 真实 Docker + B02/B01 |
| AC-18 取消失败不虚报 | PASS | B03 inspect/kill/daemon/B03-QA-03 链 |
| AC-19 并发/重复 | PASS | B01 并发/审批归属 |
| AC-20 暂停/失败/重启 | PARTIAL | 重启终态 6/6；未实测提交中断自动恢复 |
| AC-21 执行证据完整 | PASS | Docker events/inspect/ps/SQLite/Git |
| AC-22 无阻断回归 | PARTIAL | 151 项套件；未重跑 live OpenClaw 非编程工作流 |

### 10 E2E

| E2E | 状态 | 证据 |
|---|---|---|
| E2E-01 未授权 Shell 拒绝 | PARTIAL | 单元/配置；未 live MCP |
| E2E-02 伪造审批拒绝 | PASS | PRE-A02 |
| E2E-03 真实审批后合法执行 | PASS | 真实 Claude E2E |
| E2E-04 测试失败阻断提交 | PASS | AC-13 |
| E2E-05 无关文件不进 Commit | PASS | AC-15 |
| E2E-06 跨项目/路径逃逸 | PASS | AC-04/AC-10 |
| E2E-07 取消竞态 | PASS | B03 真实 Docker + B02/B01 |
| E2E-08 Workflow 权限绕过 | PARTIAL | 配置测试；未 live workflow |
| E2E-09 审批绑定/重放 | PASS | PRE-A03/挑战测试 |
| E2E-10 非编程工作流回归 | PARTIAL | smoke/单元；未 live OpenClaw |

### 15 EV

| EV | 证据 |
|---|---|
| EV-01 固定基线/目标 | 本报告第 1 节 + G0 Commit |
| EV-02 完整 Diff | `docs/23-b03.diff` |
| EV-03 修改文件清单 | 第 9 节 |
| EV-04 安全执行调用链 | 第 2–3 节 + 源码 |
| EV-05 审批机制/可信来源 | 既有报告 + 第 8 节 |
| EV-06 Shell 注入负向 | security.test AC-01/AC-08 |
| EV-07 未授权写入负向 | PRE-A02/AC-02 |
| EV-08 跨项目/路径逃逸 | AC-04/AC-10 |
| EV-09 测试失败阻断 Commit | AC-13 |
| EV-10 合法执行/验证/Commit | 第 6 节真实 E2E |
| EV-11 Git 提交范围 | AC-15 |
| EV-12 取消/并发竞态 | 第 4–6 节 + 真实 Docker |
| EV-13 原有功能回归 | 本机 151/151、CI 151/148/3 |
| EV-14 执行状态/审计记录 | Docker events + SQLite |
| EV-15 环境限制/风险/回滚 | 第 10–11 节 |

## 9. 修改文件与 Diff

```text
docs/contracts/p0-sec-01-b03-qa-v1.0.md       （G0 冻结，403 行）
orchestrator/src/isolation.mjs
orchestrator/src/service.mjs
orchestrator/scripts/verify-b01-docker-race.mjs
orchestrator/scripts/b03-docker-evidence.mjs
orchestrator/test/b03-inspect.test.mjs
orchestrator/test/b03-validator.test.mjs
orchestrator/test/b02-timeout.test.mjs        （fake inspect 目标身份修正）
orchestrator/test/docker-fault.test.mjs       （fake inspect 目标身份修正）
```

完整 Diff：`docs/23-b03.diff`（`f525276..3f5e5ac`，993 行）。

## 10. 测试与 CI

本机：

```text
node --test orchestrator/test/*.test.mjs
tests 151 / pass 151 / fail 0 / skipped 0
```

B03 定向：14/14 PASS。  
B03 验证器反向：20/20 PASS。  
B02 回归：21/21 PASS。  
B01 回归：7/7 PASS。  
SIGKILL：6/6 PASS。  
Docker isolation：2/2 PASS。  
真实 Docker 竞态：2/2 PASS（含完整 events）。

GitHub Actions（实现 Commit `3f5e5ac`）：

- Run: https://github.com/bojing951-hash/jarvis-coding/actions/runs/41281026169
- `unit + fault-injection` success
- `contract integrity` success
- Node v24.22.1

```text
tests 151 / pass 148 / fail 0 / cancelled 0 / skipped 3
```

3 个 skip 全部是 CI 无执行器镜像的显式 Docker skip：

- Docker 验证容器实际执行；
- Docker 审计/验证只读挂载；
- FIX3-D 只读挂载。

本机已真实执行；未以 skip 冒充 PASS。

## 11. 未验证事项、风险与回滚

### 未验证 / WAITING

1. AC-02/AC-08/E2E-01/E2E-08：未重跑 live MCP/Workflow。
2. AC-20：未实测“提交中断后自动恢复”。
3. AC-22/E2E-10：未重跑 live OpenClaw 非编程工作流。
4. 真实 Audit 模型调用未重跑；Audit 生命周期由 B01-C + 真实只读挂载测试覆盖。
5. CI 不执行真实 Docker；3 个 skip 已披露。

### 风险

- Docker events 查询依赖 daemon 事件历史；`eventsOk=false` 时验证器 FAIL，不伪造事件。
- `No such object` 必须明确匹配目标名称；Docker 版本若改变错误格式，结果 Fail Closed。
- `--cidfile` 检测窗口 5 秒；未命中时 Fail Closed。
- 启动屏障等待上限 15 秒；Docker API 极慢 → unknown。
- `killAccepted` 依赖 kill 命令成功；容器自然退出且 kill 被拒绝时返回未确认。
- Orchestrator 在 starting 状态崩溃 → unknown，不会自动视为停止。

### 回滚

```bash
git checkout fix/p0-sec-01-b03
git reset --hard f5252766e6c06a219d0f933e69cbefaaec739374
docker rmi jarvis-b01-exec:test
```

G0 补充契约不得在开发中修改；回滚会一并移除 B03 契约与修复。

## 12. 门禁结论

| 门禁 | 状态 |
|---|---|
| G0 开发准备/契约冻结 | 通过（9e83743） |
| G1 旧失败/新通过 | 通过（旧版 inspect 4/13 fail、旧验证器 ps 失败仍 PASS；新版对应 FAIL/exit 1） |
| G2 自动质量 | 通过（151/151 本机；CI 151/148/3；真实 Docker/Mac） |
| G3 独立验收 | 未开始 |
| 正式 PASS | **未宣布** |

**本工作包：`READY_FOR_INDEPENDENT_AUDIT`。**

开发方不自行宣布正式 PASS；AC-02/08/20/22 与 E2E-01/08/10 的 PARTIAL 状态由 Agent 2 独立裁决。
