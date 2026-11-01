# 20 · P0-SEC-01-FIX3-CLOSE 开发与证据报告

> 状态：**DEVELOPMENT_DELIVERED / READY_FOR_INDEPENDENT_AUDIT**  
> 不宣布正式验收 PASS。G3 独立验收尚未开始。  
> 开发起点：`387c81dbcd7d977f931b3e5210d7fce4ec0f3a0f`  
> 实现目标 Commit：`d7a14f34ba29e9580d1b9c1ab472a80b8c500a9c`  
> 分支：`fix/p0-sec-01-fix3-close`  
> 契约：`docs/contracts/p0-sec-01-ac-v1.0.md`，21,297 bytes，  
> SHA-256 `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0`，22 AC / 10 E2E / 15 EV。

## 1. 结论摘要

P0-SEC-01-FIX3 独立预审确认的三项审批缺陷已修复，并有修复前失败/修复后通过的对照证据：

| 缺陷 | 修复前 | 修复后 |
|---|---|---|
| PRE-A01 审批消耗与 Commit 冲突 | 合法执行到 Commit 前被拒绝：“没有与该任务参数匹配的审批记录” | 审批归属到 Execution；同一 Execution 可完成真实 Commit/Ref，新执行不得复用 |
| PRE-A02 未认证签发 | 直接 `issueApproval({auth:null})` 可写入审批 | 服务层强制验签 + 挑战绑定 + 原子写入；无证明/伪造证明拒绝 |
| PRE-A03 审批内容漂移 | 签名摘要 A、签发摘要 B 可不一致；校验配置内容变化不使审批失效 | 事务内复核摘要、挑战、任务参数；摘要覆盖校验配置内容 |

生产 Secure Enclave 签名器已实现并部署，真实 Mac 验证包括：

- 生产 key：SE wrapped blob 427 bytes（0600）+ SPKI 91 bytes；
- 生产签名：71-byte DER，EVP 验签通过，篡改载荷失败；
- 真实审批：服务端验签 + 挑战消耗 + 审批记录成功，重放失败；
- 真实 Claude Code + Docker + GLM + SE 审批合法写入 E2E：Task done、真实 Commit、Ref 验证通过、测试 `FEATURE_OK`。

CI（实现 Commit `d7a14f3`）：**89 tests / 86 pass / 0 fail / 3 skip**，`contract integrity` 通过。  
3 个 skip 全部是 CI 无执行器镜像导致的显式 Docker 跳过；本机真实 Docker 已执行通过。

## 2. 固定输入与 Diff

- 起点：`387c81d`（`fix/engineering-gate-v2` 的最终 HEAD）。
- 实现 Commit：`d7a14f3`。
- 完整 Diff：`docs/20-fix3-close.diff`（`git diff 387c81d..d7a14f3`，2,138 行）。
- 修改文件：15 个，+1,515 / −173。
- `main` 未修改；FIX3 原分支 `3ad1150` 未修改；冻结契约未修改。

## 3. PRE-A01：审批消耗与 Git Commit 冲突

### 3.1 修复前复现

在修复前版本上，用真实 SQLite、真实 git、受控隔离替身跑合法链路，结果：

```text
✖ PRE-A01 同一 Execution 消耗审批后仍可完成合法提交
commit: {"ok":false,"skipped":true,
         "reason":"没有与该任务参数匹配的审批记录"}
verdict: {"status":"failed"}
task: "failed"
```

根因：执行启动时 `UPDATE approvals SET used_at=?` 消耗审批；Commit 前又调用 `findValidApproval()`，该函数要求 `used_at IS NULL`，必然拒绝当前执行刚刚合法取得的审批。

### 3.2 修复

- `approvals` 增加 `execution_id`（含迁移和索引）。
- 审批消耗、任务状态抢占、Execution 行插入在**同一 `BEGIN IMMEDIATE` 事务**内完成。
- 新增 `findApprovalForExecution(taskId, digest, executionId)`：只认 `used_at` 已写入、`execution_id` 精确匹配、未撤销、未过期的审批。
- Commit 前重新：
  - 解析当前任务参数（`resolveExecutorPlan`），要求当前 digest 等于审批 digest；
  - 检查审批归属当前 Execution、未撤销、未过期；
  - 通过 `commitGate` 后才原子迁移 `status='committing'` 并执行 Git Commit。
- 取消/失败/重试不会清除 `used_at`；新 Execution 只能重新申请审批。

### 3.3 修复后证据

```text
✔ PRE-A01 同一 Execution 消耗审批后仍可完成合法提交
taskStatus: done
commitSha: 真实 SHA
refVerified: true
approval.execution_id == executionId
tokenFileEmpty: true
```

新增的对照测试还包括：

- 提交前任务参数漂移 → 拒绝提交；
- 执行期间审批被撤销 → 拒绝提交；
- 已消耗审批用于重试 → `needs_approval`，不启动新执行；
- 取消先于提交 → 不调用 `gitCommit`，HEAD 不变；
- 提交中取消 → `commit_in_progress`，不虚报 cancelled；
- 提交子进程异常 → 保留 `committing` + running execution，等待人工核查。

## 4. PRE-A02：未经认证的签发接口

### 4.1 修复前复现

```text
✖ PRE-A02 直接调用 issueApproval 无签名证明必须拒绝
  auth=null 仍成功写入审批

✖ PRE-A02 直接登记可信校验配置无签名证明必须拒绝
  createVerifyProfile 直接写入成功
```

### 4.2 修复

- `issueApproval()` 只接受 `proof = { nonce, payload, signatureB64 }`；
  - 用固定 `AUTH_PUBKEY` 验证签名；
  - 校验 payload 的 `task_id / digest / nonce / expires_at`；
  - 校验挑战存在、未使用、未过期、task_id/digest/expires_at 完全匹配；
  - 事务内重新计算当前 digest，再消耗挑战并写入审批。
- 不再接受 `auth=null`、`verified=true`、`auth.method` 等自报字段。
- `createVerifyProfile()` 同样要求内容挑战签名，校验 `content` 与实际 `program/argv/cwd/timeout` 完全一致后，才消耗挑战并写入配置。
- CLI 不再自行验签/消耗挑战；只负责调用签名器，把 proof 交给服务层。

### 4.3 修复后证据

```text
✔ auth=null → ok:false，审批数不变
✔ 伪造 signatureB64 → ok:false，审批数不变
✔ 无 proof 登记校验配置 → 抛错
✔ 合法 proof → 审批/校验配置写入
✔ 服务层源码包含 verifyApprovalSignature（测试检查）
```

## 5. PRE-A03：审批内容漂移

### 5.1 修复前复现

```text
✖ PRE-A03 签名后修改任务参数必须拒绝签发
  challenge 绑定摘要 A，修改任务后 issueApproval 仍成功写入

✖ PRE-A03 校验配置内容变化必须使原审批失效
  修改 verify_profiles.argv 后原签名仍可签发
```

### 5.2 修复

- `taskDigest()` 增加 `verify_profile_sha`，覆盖：
  - `program`
  - `argv`
  - `cwd`
  - `timeout_ms`
- `issueApproval()` 在事务内重新解析任务，要求当前 digest === 签名 payload digest；否则拒绝。
- 审批写入与挑战消耗在同一事务内；失败不留下半成品。
- Commit 前再次复核当前 digest，参数在执行期间变化同样拒绝提交。

### 5.3 修复后证据

```text
✔ 签名后修改 executor_config → issueApproval ok:false，审批数 0
✔ 修改校验配置 argv → issueApproval ok:false，审批数 0
✔ 提交前参数漂移 → commit.skipped，HEAD 不变
✔ 执行期间审批撤销 → commit.skipped，HEAD 不变
```

## 6. 生产 Secure Enclave 审批

### 6.1 实现

`orchestrator/darwin/approval-signer.swift` 已从 Keychain 持久化改为：

- CryptoKit `SecureEnclave.P256.Signing.PrivateKey`；
- 访问控制 `.userPresence` + `.privateKeyUsage`；
- 持久化 427-byte wrapped key blob（不是原始私钥）；
- 私钥不可导出；每次签名要求 Touch ID/系统密码；
- `keygen` 写 `approval.sekey`（0600）和 `pubkey.der`（SPKI，0644）；
- `sign` 校验 blob 权限必须为 0600，拒绝过宽权限；
- `pubkey` 读取 SPKI，不触发认证；
- 构建/安装脚本：`orchestrator/darwin/build-auth-signer.sh`。

### 6.2 生产部署

```text
~/.openclaw/jarvis/bin/jarvis-auth          89,848 bytes（新）
~/.openclaw/jarvis/bin/jarvis-auth.bak-fix3-close-20261101012822（旧 ad-hoc）
~/.openclaw/jarvis/auth/approval.sekey      427 bytes, 0600
~/.openclaw/jarvis/auth/pubkey.der          91 bytes, 0644
```

生产公钥：

```text
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAELUk9e5/1NK3nAMRbneUlep+dEmyYhyjK74qK86B4t1IIXjRFGewpE7USFhJJflKYX/XKOMJsRNB54mwmK8K6Ow==
```

真实生产密钥签名（用户完成一次系统认证）：

```text
signatureBytes: 71
productionSignatureValid: true
tamperedValid: false
```

### 6.3 真实审批 E2E（服务层）

```json
{
  "signatureBytes": 71,
  "signatureValid": true,
  "tamperedValid": false,
  "issuedOk": true,
  "approvalValid": true,
  "replayOk": false,
  "challengeReplayConsumed": false
}
```

### 6.4 真实 Claude Code + Docker + GLM 合法写入 E2E

执行脚本：`orchestrator/scripts/verify-real-claude-e2e.mjs`。  
环境：临时 HOME/JARVIS_HOME/仓库；真实 `jarvis-executor:2.1.104`、临时 egress proxy、生产 GLM key（只读挂载）、生产 SE 审批密钥；用户完成系统认证。

结果：

```json
{
  "task": "tsk_mvx8355k03cunq",
  "approvalId": "apv_mvx837i105xtum",
  "approvalExecutionId": "exe_mvx837lw07uc8c",
  "executionId": "exe_mvx837lw07uc8c",
  "executionStatus": "ok",
  "taskStatus": "done",
  "commitSha": "f7a86e52978e4534e77a3775ac26811a3b90d592",
  "ref": "refs/heads/jarvis/tsk_mvx8355k03cunq",
  "refVerified": true,
  "refMatchesCommit": true,
  "verdict": "done",
  "changed": ["feature.txt"],
  "verify": { "exitCode": 0, "ok": true, "output": "FEATURE_OK\n" },
  "executorText": "Created `/work/feature.txt` ... No other files were touched."
}
```

Git 层复核：

```text
commit f7a86e5 chore(executor): 真实 Claude Code 合法写入
 feature.txt | 1 +
 1 file changed, 1 insertion(+)
feature.txt == HELLO_FROM_JARVIS
refs/heads/jarvis/<task> == f7a86e5...
token file == {}
```

说明：该 E2E 由脚本发起，审批 scope 里 `_operator.method` 可能是 `non-interactive`（终端元数据）；真正的授权证明是 `_auth.method=os-signature`、一次性 nonce 和 Secure Enclave 用户在场签名，不是 TTY 或自报字段。

## 7. 取消 / Commit 竞态

- `cancelTask()` 不再对 `committing` 标记 `cancel_requested`；返回 `commit_in_progress`。
- Commit 开始使用原子状态迁移 `UPDATE ... WHERE status IN ('running','verifying')`：
  - 取消先到 → 迁移失败，不产生 Commit；
  - Commit 先到 → 取消被拒绝，等待真实 Commit/Ref 结果；
  - 取消后不启动新的执行/验证/提交。
- 测试覆盖：提交前取消、提交中取消、提交子进程异常。
- 真实 Docker 取消：`verify-cancel-sigkill.mjs` → **6/6 PASS**（SIGKILL 升级 5,940ms，任务 cancelled，跨进程终态一致）。

## 8. 模型代理令牌

- 执行结束/取消时撤销该 Execution 的全部模型令牌。
- `cancelTask()` 在终止容器前立即撤销，不依赖 runTask 进程存活。
- 新令牌注册时清理已结束 Execution 的遗留令牌。
- 代理测试：
  - 无令牌 401；
  - 过期令牌 401；
  - 未签发/已撤销令牌 401；
  - 有效令牌才进入上游（测试上游不可达 → 502）。
- `verify-risk01.mjs` → **10/10 PASS**：容器/`docker inspect`/环境/日志均无真实 GLM key，代理路径 401，非白名单 403，验证容器无凭据挂载。

## 9. Docker 执行 / 验证 / Audit 隔离

| 测试 | 本机真实 Docker | CI |
|---|---|---|
| `Docker 验证容器实际执行并返回结果` | PASS（`VERIFY_OK`） | 显式 skip（无镜像） |
| `Docker 审计/验证只读挂载阻止写入` | PASS（写入失败） | 显式 skip（无镜像） |
| `FIX3-D 只读挂载真实阻止容器写入` | PASS | 显式 skip（无镜像） |
| `verify-cancel-sigkill.mjs` | 6/6 PASS | 不在 CI |
| `verify-risk01.mjs` | 10/10 PASS | 不在 CI |

CI 的 3 个 skip 都是“执行器镜像不存在（CI 环境）”，不是静默跳过；本机已实际执行。

## 10. 测试与 CI

### 本机（macOS 15.6.1 / M4，Docker 29.9.2）

```text
node --test orchestrator/test/*.test.mjs
tests 89 / pass 89 / fail 0 / skipped 0
```

### GitHub Actions（实现 Commit `d7a14f3`）

- Run: https://github.com/bojing951-hash/jarvis-coding/actions/runs/41266343887
- Jobs：`unit + fault-injection` success；`contract integrity` success
- Node: v24.22.1（ubuntu-24.04）

```text
tests 89 / pass 86 / fail 0 / cancelled 0 / skipped 3
```

契约 job：8/8 PASS，`21,297 bytes / af157377…91b0 / AC=22 E2E=10 EV=15`。

## 11. AC / E2E / EV 证据映射

状态说明：`EVIDENCED` 有本轮直接测试/真实证据；`PARTIAL` 有代码/单元/回归证据但缺少某一真实端到端层；`AUDIT` 需独立验收方判断。**本表不宣布 AC PASS。**

### 22 AC

| AC | 状态 | 主要证据 |
|---|---|---|
| AC-01 固定版本/范围 | EVIDENCED | 起点 387c81d、目标 d7a14f3、main/FIX3 未改、Diff |
| AC-02 MCP 无未授权 Shell | PARTIAL | `security.test` 注入/白名单测试；未重新跑真实 MCP 会话 |
| AC-03 命令注入防护 | EVIDENCED | `security.test` AC-01/AC-08、argv 校验 |
| AC-04 可信验证配置 | EVIDENCED | 签名登记测试 + `createVerifyProfile` proof |
| AC-05 真实人工审批 | EVIDENCED | 生产 SE 签名、真实审批 E2E、重放拒绝 |
| AC-06 审批内容绑定 | EVIDENCED | digest 覆盖 profile 内容；参数漂移测试 |
| AC-07 审批过期/重复使用 | EVIDENCED | 挑战重放、跨任务、审批复用测试 |
| AC-08 全入口共用门禁 | PARTIAL | 配置/工作流注入测试；未重新跑真实 MCP |
| AC-09 项目执行目录 | EVIDENCED | AC-04 跨项目/路径测试 |
| AC-10 路径穿越/符号链接 | EVIDENCED | AC-10 符号链接测试 |
| AC-11 外部执行器真实限制 | EVIDENCED | 真实 Docker + risk01 10/10 |
| AC-12 合法写入正向 | EVIDENCED | 真实 Claude Code E2E：FEATURE_OK + 真 Commit |
| AC-13 测试失败阻止 Commit | EVIDENCED | `AC-13 校验失败不得产生 Commit`（真 git，HEAD 不变） |
| AC-14 缺少校验不得提交 | EVIDENCED | `AC-14 缺少可信校验不得产生 Commit` |
| AC-15 提交范围控制 | EVIDENCED | `security.test` AC-05、fix3-close 声明路径提交 |
| AC-16 成功提交真实证据 | EVIDENCED | 真实 Claude E2E commit f7a86e5 + refVerified |
| AC-17 取消后无副作用 | EVIDENCED | 取消前/提交中测试；SIGKILL 6/6 |
| AC-18 取消失败不虚报 | EVIDENCED | daemon 失联/容器仍在测试；真实 SIGKILL |
| AC-19 并发/重复执行 | EVIDENCED | AC-07 并发、审批归属、重试不复用 |
| AC-20 暂停/失败/重启 | PARTIAL | 重启 6/6、暂停/重试/过期测试；未实测重启自动续提交 |
| AC-21 执行证据完整性 | EVIDENCED | approvals/executions/events + 真实 E2E DB |
| AC-22 原有功能无阻断回归 | PARTIAL | 89 项套件；未重新跑真实 OpenClaw 非编程工作流 |

### 10 E2E

| E2E | 状态 | 证据 |
|---|---|---|
| E2E-01 未授权 Shell 拒绝 | PARTIAL | 单元/配置测试；未真实 MCP |
| E2E-02 伪造审批拒绝 | EVIDENCED | PRE-A02 无 proof/伪造 proof |
| E2E-03 真实审批后合法执行 | EVIDENCED | 真实 Claude E2E |
| E2E-04 测试失败阻断提交 | EVIDENCED | AC-13 真 git 测试 |
| E2E-05 无关文件不能进 Commit | EVIDENCED | AC-15 提交范围测试 |
| E2E-06 跨项目/路径逃逸 | EVIDENCED | AC-04/AC-10 测试 |
| E2E-07 取消竞态 | EVIDENCED | 取消前/提交中 + SIGKILL |
| E2E-08 Workflow 权限绕过 | PARTIAL | 配置校验测试；未真实 workflow |
| E2E-09 审批绑定/重放 | EVIDENCED | PRE-A03/挑战测试 |
| E2E-10 非编程工作流回归 | PARTIAL | `smoke.test`；未真实 OpenClaw 会话 |

### 15 EV

| EV | 证据 |
|---|---|
| EV-01 固定基线/目标 Commit | 本报告第 2 节、git refs |
| EV-02 完整 Diff | `docs/20-fix3-close.diff` |
| EV-03 修改文件清单 | 本报告第 2 节、git diff --stat |
| EV-04 安全执行调用链 | 本报告第 3–7 节、service/CLI 代码 |
| EV-05 审批机制/可信来源 | 本报告第 4–6 节 |
| EV-06 Shell 注入负向测试 | `security.test` AC-01/AC-08 |
| EV-07 未授权写入负向测试 | PRE-A02/AC-02 测试 |
| EV-08 跨项目/路径逃逸 | AC-04/AC-10 测试 |
| EV-09 测试失败阻断 Commit | AC-13 测试 + `computeVerdict` |
| EV-10 合法执行/验证/Commit | 真实 Claude E2E（第 6.4 节） |
| EV-11 Git 提交范围 | AC-15 测试 |
| EV-12 取消/并发竞态 | 第 7 节 + SIGKILL 6/6 |
| EV-13 原有功能回归 | 本机 89/89、CI 89/86/3 |
| EV-14 执行状态/审计记录 | approvals/executions/events + E2E DB |
| EV-15 环境限制/已知问题/回滚 | 第 12–13 节 |

## 12. 已知限制与剩余风险

1. **AC-02/AC-08/E2E-01/E2E-08/E2E-10 的 live 层**：未重新跑真实 MCP/Workflow/非编程 OpenClaw 会话；当前是服务层与配置层测试。独立审计方若要求 live 证据，应标记 WAITING。
2. **AC-20 重启自动续提交**：只验证了重启后终态读取和拒绝重复执行；未实测“提交中断后自动恢复”。
3. **SE blob 是同 UID 进程可读的 bearer capability**：拿到 blob 的进程可以发起签名请求，但每次仍需要系统用户在场；不能静默签名。`0600` 只防其他 UID/普通文件读取，不等于同 UID 进程隔离。
4. **无代码签名绑定**：blob 不绑定特定 helper 二进制；替换 helper 仍不能在没有用户在场时伪造签名，但可诱导用户批准。提示语应展示任务/权限范围；当前 CLI 已把 `approvalPreview` 传入签名器。
5. **生产 key 已生成但未做跨重启签名实测**：本次生产 key 在签名后可用；重启后的持久性需要后续专项验证。
6. **CI 跳过 3 个真实 Docker 测试**：已在本地真实 Docker 执行；CI 的 skip 是显式的，不是 PASS。
7. **真实 Claude E2E 只执行了一次**：模型输出和任务内容固定；不能据此推断所有任务的模型行为。
8. **`_operator.method` 元数据**：真实 E2E 由脚本发起，显示 `non-interactive`；安全证明是 `_auth=os-signature` + SE 签名 + nonce，不是 TTY。

## 13. 门禁状态与回滚

| 门禁 | 状态 |
|---|---|
| G0 开发准备 | 通过 |
| G1 技术与实现 | 通过（三项缺陷旧失败/新通过；SE 路线已实现） |
| G2 自动质量 | 通过（89 项本机、CI 89/86/3、真实 Mac、Docker、代理） |
| G3 独立验收 | 未开始 |
| 最终 PASS | **未宣布** |

**本工作包标记：`READY_FOR_INDEPENDENT_AUDIT`。**  
不标记正式验收 PASS；AC-02/08/20/22 的 PARTIAL 项由 Agent 2 独立判断是否需要 WAITING/补证。

回滚：

```bash
# 代码回滚到 FIX3-CLOSE 起点
git checkout fix/p0-sec-01-fix3-close
git reset --hard 387c81d

# 生产 helper 回滚（旧 ad-hoc 版本）
cp ~/.openclaw/jarvis/bin/jarvis-auth.bak-fix3-close-20261101012822 \
   ~/.openclaw/jarvis/bin/jarvis-auth
# 生产 SE key 如确认不再使用，移出 auth 目录并妥善销毁
```
