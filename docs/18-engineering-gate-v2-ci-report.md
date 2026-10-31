# JARVIS-ENG-GATE-01 · Task A：GitHub CI 修复报告

> 状态：**CI_READY**（固定代码目标 Commit 的必需检查已实际通过）  
> 代码目标 Commit：`5eae989aca6aa0ba9d935cc019572839e8c292b4`  
> 分支：`fix/engineering-gate-v2`（从 FIX3 `3ad1150c3be3f3013c5e8fe3238305d2d7c3fcdc` 创建）  
> 报告日期：2026-11-01

## 1. 固定输入

| 项 | 值 |
|---|---|
| GitHub 仓库 | `bojing951-hash/jarvis-coding` |
| FIX3 固定基线 | `3ad1150c3be3f3013c5e8fe3238305d2d7c3fcdc` |
| 工程分支 | `fix/engineering-gate-v2` |
| 代码修复 Commit | `5eae989aca6aa0ba9d935cc019572839e8c292b4` |
| 冻结契约 | `docs/contracts/p0-sec-01-ac-v1.0.md` |
| 契约 SHA-256 | `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0` |
| 契约字节数 | 21,297 |
| `main` | 未修改 |

## 2. 原失败事实

### 2.1 两次失败运行

| 运行 | 分支 / Commit | 结论 | 失败阶段 |
|---|---|---|---|
| [41219041766](https://github.com/bojing951-hash/jarvis-coding/actions/runs/41219041766) | `fix/p0-sec-01-fix3` / `3ad1150` | failure | `unit + fault-injection tests` |
| [41218939393](https://github.com/bojing951-hash/jarvis-coding/actions/runs/41218939393) | `fix/p0-sec-01-fix3` / `13188be` | failure | `unit + fault-injection tests` |

两次运行的步骤结论相同：

```text
Set up job                          success
actions/checkout@v4                 success
actions/setup-node@v4               success
unit + fault-injection tests        failure
contract integrity                  skipped
```

### 2.2 真实失败断言

失败测试：`AC-07 同一任务不得并发启动两次`  
文件位置：`orchestrator/test/security.test.mjs:208`（修复前）

```text
✖ AC-07 同一任务不得并发启动两次
  AssertionError [ERR_ASSERTION]:
  + actual   - expected
  + 'isolation_unavailable'
  - 'already_running'
```

### 2.3 两次运行的测试计数（修复前）

| 指标 | 41219041766 | 41218939393 |
|---|---:|---:|
| tests | 71 | 71 |
| pass | 69 | 69 |
| fail | 1 | 1 |
| skipped | 1 | 1 |
| todo | 0 | 0 |

跳过项为 `FIX3-D 只读挂载真实阻止容器写入`，原因是 CI 环境没有执行器镜像：

```text
﹣ FIX3-D 只读挂载真实阻止容器写入 ... # 执行器镜像不存在（CI 环境），跳过真实挂载测试
```

## 3. 根因

### 3.1 直接原因

`runExecutorTask()` 的检查顺序是：

```text
执行器校验 → 计划解析 → 审批 → isolationStatus() → 工作树规格 → 事务内状态抢占
```

在 GitHub `ubuntu-latest` 上：

1. Docker 守护进程可能存在，但缺少 `jarvis-executor:2.1.104` 镜像和 `jarvis-internal` 内部网络；
2. `isolationStatus()` 因此返回 `available:false`；
3. `runExecutorTask()` 在到达事务内状态抢占之前，就返回 `isolation_unavailable`；
4. 测试期望的是“同一任务已在运行”应返回 `already_running`。

也就是说：**并发保护被环境探测遮蔽了**。任务确实不会被启动两次，但拒绝原因的语义不稳定，且取决于本机 Docker 状态。

### 3.2 为什么本地没有发现

本机安装了 Docker Desktop 29.9.2，存在 `jarvis-executor:2.1.104` 镜像和隔离网络：

```text
Docker image inspect jarvis-executor:2.1.104 -> sha256:ee5998bb...
FIX3-D 只读挂载真实阻止容器写入 -> ✔ 919ms
```

所以本机 `isolationStatus()` 通过，测试能走到事务抢占并得到 `already_running`。本地运行 `node --test orchestrator/test/*.test.mjs` 为 **71/71 通过、0 跳过**，因此仅靠本地结果无法发现 CI 的失败。

### 3.3 已排除的猜测

| 猜测 | 实际检查 | 结论 |
|---|---|---|
| Node 24 不兼容 | CI 实际 `node v24.22.1`；本地 `v24.13.1`；其余 69 项通过 | 排除 |
| Linux/macOS 路径差异 | 测试使用 `node:path` / `os.tmpdir`；Linux 上 69 项通过；无路径相关失败 | 排除 |
| 测试依赖缺失 | `orchestrator/package.json` 无第三方依赖；只用 Node 内置模块与 `git` | 排除 |
| Docker 镜像/网络缺失 | 是失败的必要条件：CI 无 `jarvis-executor:2.1.104` / `jarvis-internal` | **确认** |
| 测试间状态污染 | 各测试文件使用独立临时 `JARVIS_HOME`/`JARVIS_DB`；65+ 项稳定通过 | 排除为主因 |
| Linux 误跑 macOS 专项测试 | Node 测试集中没有 Keychain/LocalAuthentication/SE/Swift 测试；唯一 Docker 测试显式跳过 | 排除 |
| 契约完整性检查本身失败 | 它是同 job 的第 5 步，因第 4 步失败被 **skipped**，并未执行 | 不是本次失败原因，但属于 CI 设计缺陷 |

### 3.4 产品行为缺陷还是测试环境问题

两者都有，但**不能只用“改测试”解决**：

- 测试依赖 Docker 可用性，属于测试设计问题；
- `runExecutorTask()` 在“任务已在运行”这一确定性状态下仍先探测 Docker，属于产品行为顺序问题：同一个任务状态在不同机器上返回不同 `blocked` 原因，且会进行无意义的 Docker 探测。
- 如果只把断言改成接受 `isolation_unavailable`，会放宽安全测试的语义，并留下“CI 通过但行为仍不确定”的问题。因此采用最小产品修复 + 强化测试。

## 4. 缺陷记录 DEF-CI-01

| 项 | 内容 |
|---|---|
| 编号 | `DEF-CI-01` |
| 类型 | 产品行为顺序 / 测试环境依赖 |
| 严重度 | 中（CI 门禁失败；未造成执行绕过，安全仍是 fail-closed） |
| 影响 | 任务已运行时，在无执行器镜像的主机上返回 `isolation_unavailable` 而非 `already_running`；CI 红；契约检查被跳过 |
| 根因 | `runExecutorTask()` 在事务内状态抢占之前调用 `isolationStatus()`；测试假设 Docker 可用 |
| 修复 | 在环境探测前增加“任务已在运行”早退；测试显式模拟无执行器镜像；契约检查独立成 job |
| 安全影响 | 早退只会更早拒绝，不增加任何执行路径；事务抢占与 fail-closed 逻辑保留 |
| 证据 | 修复前 CI 失败日志、修复后 CI 通过日志、强制无镜像的本地复现 |

## 5. 修复内容

### 5.1 产品代码（最小改动）

`orchestrator/src/service.mjs`：在 `runExecutorTask()` 开头增加：

```js
if (task.status === 'running') {
  recordAttempt({ task, project, phase: 'claim', status: 'rejected', blocked: 'already_running', reason: '任务已在运行' });
  return { ok: false, blocked: 'already_running', error: '任务已在运行或状态不允许执行' };
}
```

保留后续事务内的 `UPDATE tasks ... WHERE status IN (...)` 抢占；早退不是授权，不改变任何执行条件。

### 5.2 测试强化

`orchestrator/test/security.test.mjs` 的 AC-07：

- 在调用 `runTask` 前设置 `JARVIS_EXECUTOR_IMAGE=jarvis-ci-nonexistent:0`；
- 用 `try/finally` 恢复原环境变量；
- 断言仍是严格的 `blocked === 'already_running'`，没有放宽。

这样测试在有无 Docker 的机器上都会覆盖“无执行器镜像”的 CI 条件，而不是被本机 Docker 掩盖。

### 5.3 CI 工作流

`.github/workflows/ci.yml`：

1. **契约完整性独立成 `contract` job**，不再与测试同 job，不会再因测试失败被 skip。
2. 新增 `scripts/verify-contract.mjs`，跨平台检查：
   - 契约 SHA-256；
   - 字节数；
   - manifest 的 SHA/bytes/status；
   - AC=22、E2E=10、EV=15 计数。
3. 测试 job 保持 `node --test orchestrator/test/*.test.mjs`，Node 24。
4. 增加 `permissions: contents: read` 与 job 超时，减少权限面和挂起风险。

修改文件：

```text
.github/workflows/ci.yml
orchestrator/src/service.mjs
orchestrator/test/security.test.mjs
scripts/verify-contract.mjs
```

## 6. 修复后验证

### 6.1 本地

| 场景 | 结果 |
|---|---|
| 修复前，强制 `JARVIS_EXECUTOR_IMAGE=jarvis-ci-nonexistent:ci`，只跑 AC-07 | **失败**：actual `isolation_unavailable` |
| 修复后，同一强制条件，只跑 AC-07 | **通过**：1/1 |
| 修复后，完整套件（本机 Docker 可用） | **71 tests / 71 pass / 0 fail / 0 skipped** |
| `FIX3-A` 签名验签/重放/绑定 | **6/6 pass** |
| `FIX3-D` 真实 Docker 只读挂载 | **通过**（919ms，真实镜像 `jarvis-executor:2.1.104`） |
| `node scripts/verify-contract.mjs` | 8/8 PASS，契约 21,297 bytes / SHA 一致 |

### 6.2 GitHub CI（代码目标 Commit）

运行：[41221515926](https://github.com/bojing951-hash/jarvis-coding/actions/runs/41221515926)  
Commit：`5eae989aca6aa0ba9d935cc019572839e8c292b4`

| Job | 结论 |
|---|---|
| `contract integrity` | **success** |
| `unit + fault-injection` | **success** |

测试计数（来自 CI 原始日志）：

```text
ℹ tests 71
ℹ pass 70
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
```

唯一跳过项仍是 `FIX3-D`，原因明确：“执行器镜像不存在（CI 环境）”。该测试已在本地真实 Docker 上执行通过，因此不是静默跳过，也不是把跳过当通过。

契约 job 的 8 项检查全部 PASS：

```text
PASS contract sha256: af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0
PASS contract bytes: 21297
PASS manifest sha256: ...
PASS manifest bytes: 21297
PASS manifest status: FROZEN_VERIFIED
PASS manifest ac_count: 22
PASS manifest e2e_count: 10
PASS manifest ev_count: 15
contract integrity OK
```

CI 环境：Ubuntu 24.04 x86_64，Node `v24.22.1`。

## 7. 逐项检查回答

| 检查项 | 结论 |
|---|---|
| 1. Node 24 环境 | `actions/setup-node` 固定 24；CI 实际 v24.22.1；`engines` 要求 >=24；无 Node 24 兼容问题 |
| 2. Linux 与 macOS 路径差异 | 测试使用 `node:path` 与 `os.tmpdir`；Linux 通过 70 项；macOS 本地完整 71 项通过；未发现路径相关失败 |
| 3. 测试依赖 | 零第三方 npm 依赖；Node 内置模块 + `git`；不需要 `npm install` |
| 4. Docker 镜像与环境依赖 | CI 缺少 `jarvis-executor:2.1.104` / `jarvis-internal`；`FIX3-D` 显式 skip；AC-07 已改为不依赖 Docker；本地真实 Docker 测试通过 |
| 5. 测试之间状态污染 | 测试文件各自使用临时 `JARVIS_HOME`/`JARVIS_DB`；修复后套件稳定；未发现跨测试污染 |
| 6. Linux 误跑 Mac 专项测试 | Node 测试中没有 Keychain/LA/SE/Swift 专项；这些只在真实 Mac 上验证（见 `docs/spikes/auth-feasibility-report.md`）；无 Linux 误跑 |
| 7. 契约完整性检查 | 旧实现位于测试之后，失败时被 skip；新实现为独立 job，8 项校验全部通过 |

## 8. 已知限制

1. **CI 不执行 macOS 专项认证测试**：Touch ID、Keychain、Secure Enclave 无法在 Linux runner 真实执行。本轮用真实 Mac 做了可行性与认证验证，见 `docs/spikes/auth-feasibility-report.md`。
2. **CI 跳过真实 Docker 只读挂载测试**：这是环境限制，不是静默跳过；本地已在真实 Docker 镜像上验证通过。若要把该测试纳入 CI，需要构建/拉取执行器镜像并创建隔离网络，属于后续基础设施工作。
3. **CI 目前只有 Linux job**：macOS 路径差异用本地真实 macOS 套件覆盖；是否增加 macOS runner 属后续成本/收益决定。
4. **文档提交后的 HEAD 运行**：本报告对应代码目标 `5eae989`；文档与报告提交后的最终 HEAD 运行以交付回复中给出的 URL/SHA 为准，并需保持同样全绿。

## 9. 门禁结论

- **CI_READY**：固定代码目标 Commit `5eae989aca6aa0ba9d935cc019572839e8c292b4` 的必需检查（`contract integrity`、`unit + fault-injection`）均已实际通过。
- 没有修改 `main`，没有修改冻结契约，没有删除/放宽安全测试，没有用本地结果冒充 CI。
- 本结论不包含 macOS 审批生产修复；审批可行性见独立报告。
