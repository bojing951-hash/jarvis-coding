# JARVIS-ENG-GATE-01 · 最终门禁结论

> 工作包：CI 修复与 macOS 审批技术可行性验证  
> 分支：`fix/engineering-gate-v2`  
> 基线：`3ad1150c3be3f3013c5e8fe3238305d2d7c3fcdc`  
> 代码目标 Commit：`5eae989aca6aa0ba9d935cc019572839e8c292b4`  
> 日期：2026-11-01

## 1. 交付物

| 交付 | 文件 |
|---|---|
| A. 工程流程 v2.0 | [`docs/engineering-process-v2.md`](engineering-process-v2.md) |
| B. CI 修复报告 | [`docs/18-engineering-gate-v2-ci-report.md`](18-engineering-gate-v2-ci-report.md) |
| C. macOS 审批可行性报告 | [`docs/spikes/auth-feasibility-report.md`](spikes/auth-feasibility-report.md) |
| C. 实验代码（非生产） | [`docs/spikes/se-keytool.swift`](spikes/se-keytool.swift) |
| D. 本结论 | `docs/19-engineering-gate-v2-summary.md` |

## 2. 四门禁结果

### G0｜开发准备门禁：通过

| 检查 | 结果 |
|---|---|
| Git 固定版本 | `3ad1150`，与 FIX3 固定值一致 |
| 正式验收契约 | 21,297 bytes；SHA-256 `af157377…91b0`；与冻结值一致 |
| 开发范围 | 仅 CI 修复 + 审批可行性验证；未开发 FIX4 |
| 必要输入 | 仓库、契约、CI 日志、真实 Mac 环境均可访问 |
| 技术前置条件 | Node 24、Docker（本地）、macOS 15.6.1/M4、Touch ID 可用 |
| 分支隔离 | 从固定 Commit 创建 `fix/engineering-gate-v2`；`main` 未修改 |

### G1｜技术与实现门禁：通过

| 项 | 证据 |
|---|---|
| CI 缺陷失败复现 | 旧版本在无执行器镜像时 `AC-07` 返回 `isolation_unavailable`，与 CI 失败一致 |
| CI 缺陷修复验证 | 新版本在相同强制条件下通过同一测试，断言未放宽 |
| 审批根因 | `securityd` 日志：缺少 application-identifier / app-groups / keychain-access-groups entitlement |
| 审批最小实验 | CryptoKit SE + `.userPresence` + wrapped blob；真实 Touch ID、不可导出、Node 验签、防篡改/防伪造 |
| 未验证设计不扩展 | 生产审批器未改写；路线只作为后续实现建议 |

### G2｜自动质量门禁：通过（代码目标 Commit）

| 检查 | 结果 |
|---|---|
| 单元测试 | CI：71 tests / 70 pass / 0 fail / 1 skip |
| 失败注入测试 | 包含在套件中；AC-07 强制无镜像条件；FIX3-A 6/6 本地通过 |
| 必要集成测试 | 本地真实 Docker：FIX3-D 只读挂载通过（919ms，镜像存在） |
| GitHub CI | [run 41221515926](https://github.com/bojing951-hash/jarvis-coding/actions/runs/41221515926)：两个 job 全部 success |
| 真实环境专项验证 | 真实 Mac：Touch ID、Secure Enclave、Keychain 探针、签名/验签、AMFI 限制 |
| 执行证据检查 | 运行 URL、Commit SHA、测试计数、契约 8/8 校验、日志均有记录 |
| 契约完整性 | 独立 job；21,297 bytes / SHA-256 / manifest / AC=22 / E2E=10 / EV=15 全部 PASS |

跳过项：`FIX3-D 只读挂载真实阻止容器写入`。原因：CI 没有执行器镜像。该测试不是静默跳过，已在真实 Docker 本地执行通过；报告已单独归类。

### G3｜独立验收：未开始

- 本轮由 Agent 3 开发，**未**由 Agent 2 独立检查。
- Agent 3 不宣布最终 PASS。
- 正式移交前，Agent 2 需要在固定 Commit 上独立复核：Diff、CI URL、测试计数、契约校验、真实 Mac 证据。
- 若 Agent 2 无法访问真实 Mac/Touch ID，应标记 `WAITING`，不得以本报告替代独立证据。

## 3. 最终状态

| 维度 | 状态 |
|---|---|
| CI | **CI_READY**（代码目标 `5eae989` 的必需检查实际通过） |
| macOS 审批可行性 | **AUTH_FEASIBLE**（推荐路线已在真实 Mac 验证；生产尚未实现） |
| 生产审批可用性 | **未修复**：`jarvis-auth keygen` 仍返回 `-34018` |
| 独立验收 | **未开始**：等待 Agent 2 |
| 整个工程任务 | **NOT READY**（不得宣布 READY / PASS） |

**为什么不是整个任务 READY：**

1. 审批只完成了“可行性验证”，推荐路线尚未合入生产；当前生产密钥仍无法生成。
2. G3 独立验收尚未进行；开发方不能自证通过。
3. Docker 真实挂载测试在 CI 中仍为显式跳过（本地有真实证据），需要独立验收方判断是否接受。

## 4. 已知风险与后续

| 风险 / 后续项 | 说明 |
|---|---|
| 生产审批实现 | 按报告方案 B 改写 `approval-signer.swift`，保存 SE blob + SPKI 公钥；需要独立工作包与真实 Touch ID 回归 |
| 重启持久性 | 尚未实测 SE blob 跨重启；实现阶段必须补做 |
| blob 保护 | 0600；bearer capability；需防社会工程与提示语伪造 |
| 无代码签名绑定 | blob 可被任何可读进程加载并发起认证；服务端挑战绑定可防伪造审批，但不能防诱导批准 |
| CI Docker 测试 | 可后续增加构建镜像/创建网络的 job，或保持显式跳过 + 本地真实证据 |
| CI macOS 矩阵 | 当前无 macOS runner；本轮以本地真实 macOS 套件覆盖路径差异 |
| 最终 HEAD 运行 | 文档提交后的 HEAD 需保持同一套 CI 全绿；以交付回复中的 URL/SHA 为准 |

## 5. 明确声明

- 未修改冻结验收契约。
- 未修改 `main`。
- 未开发 FIX4。
- 未删除测试、放宽断言或静默跳过必需测试。
- 未用本地结果冒充 GitHub CI。
- 未用模拟认证冒充真实 macOS 认证。
- 未把开发完成冒充独立验收通过。
- 本工作包可以移交 Agent 2 做独立验收，但 **不等于 PASS**。
