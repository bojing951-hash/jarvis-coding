# JARVIS-P0-SEC-01-B03-QA-v1.0

B03 开发前冻结补充验收契约

契约编号：JARVIS-P0-SEC-01-B03-QA-v1.0  
对应工作包：JARVIS-P0-SEC-01-FIX3-CLOSE-B03  
状态：FROZEN｜2026-11-01｜开发前制定  
制定主体：Agent 1  
执行主体：Agent 3  
独立验收：Agent 2

本契约在代码修复开始前确定。

必须完整继承：

- 原冻结 AC-01～22。
- 原冻结 E2E-01～10。
- 原冻结 EV-01～15。
- B01-QA-01～07。
- B02-QA-01～10。

本契约新增 B03-QA-01～09。

不得修改、删除或弱化既有验收要求。

---

## B03-QA-01｜inspect 异常输出不得成为可信事实

**前置：**

使用真实生产 sh()、killContainer() 调用链，能够控制 Docker CLI 的退出行为。

**测试：**

分别模拟或实际触发：

1. 正常退出且返回 running。
2. 正常退出且返回 exited。
3. 正常以非零退出码报告 No such object。
4. 输出 No such object 后超时。
5. 输出 No such object 后被 SIGTERM 终止。
6. 部分 stdout 后超时。
7. 部分 stderr 后超时。
8. 非零退出但错误文本无法识别。
9. 返回与目标容器不匹配的错误文本。

**预期：**

正常完成的可信状态可以被正确识别。

正常完成且具有可信、明确容器不存在证据的非零退出，可识别为 gone。

异常结束时，无论输出内容如何，都不能从部分文本生成可信 gone 或停止结论。

**FAIL：**

任何 timeout、signal、killed 或异常执行，仅因输出包含 No such object 就得到 confirmed=true。

**证据：**

Node 原始错误对象、生产 sh() 结果、killContainer() 返回、退出码、signal、完整测试日志。

---

## B03-QA-02｜正常 Docker 停止语义不回归

**前置：**

Docker 处于可用状态，有明确身份的测试容器。

**测试：**

分别验证：

- TERM 成功且容器退出。
- TERM 无效后 KILL 成功且容器退出。
- 可信 inspect 返回 exited。
- 可信 inspect 返回 dead。
- 可信 inspect 返回 removing。
- 可信 Docker 查询证明容器已不存在。
- kill 返回成功，但随后 inspect 仍为 running。
- kill 返回失败，但另有独立可信停止证据。

**预期：**

真实可信停止可以确认。

kill 返回成功并不单独证明容器已停止。

错误的 kill 结果不能自动成为可信终止证明。

异常查询不得确认停止。

**FAIL：**

修复导致所有正常取消无法完成，或仍出现未经证实的停止确认。

**证据：**

真实 Docker 命令、容器 ID、状态、终止结果、Execution/Resource 记录。

---

## B03-QA-03｜终止证明沿完整调用链传播

**前置：**

存在执行中或启动中的 Task、Execution、Resource。

**测试：**

将可信与不可信 Docker 查询结果分别传入：

killContainer → settleCancelResource → cancelTask

覆盖：

- intent。
- starting。
- started。
- running。
- stopping。
- unknown。

**预期：**

没有停止证据时：

- cancelTask() 不得返回成功。
- Task 不得错误进入 cancelled。
- Execution 不得错误标记 cancelled。
- 资源应保留未确认状态。
- 不得允许错误重试或新执行。
- 不得被迟到完成回调覆盖为错误终态。

已有可信停止证据时，正常取消可以完成。

**FAIL：**

任何不可信查询结果最终造成虚假取消成功。

**证据：**

SQLite 前后状态、取消返回值、资源生命周期记录和测试日志。

---

## B03-QA-04｜真实 Docker 生命周期证据完整

**前置：**

独立 Docker 测试环境，具有唯一 Execution ID、容器 ID 和测试资源。

**测试：**

使用固定代码运行真实启动/取消竞态。

必须采集：

- create。
- start。
- die。
- destroy。
- Docker inspect。
- Docker ps。
- SQLite。
- Git HEAD。
- 取消操作与容器事件顺序。

**预期：**

确认容器真实创建、真实运行、真实停止，并按测试约定清理。

所有容器标识必须一致。

Docker events 和最终物理状态必须支持脚本报告的成功结论。

任何必要证据缺失或无法核实，测试不得 PASS。

**FAIL：**

仅因 docker ps 为空便判定成功，或在缺少真实事件/可信终止证据时宣称通过。

**证据：**

Docker 原始事件日志、容器 ID、状态输出、Execution ID、Resource ID、Git 状态与完整测试结果。

---

## B03-QA-05｜真实 Docker 验证器必须能检测自身失败

**前置：**

可向现有验证器注入或隔离模拟关键 Docker 查询异常。

**测试：**

分别制造：

1. Docker ps 非零退出。
2. Docker ps 超时。
3. Docker inspect 非零未知错误。
4. Docker inspect 超时。
5. Docker inspect 返回 running。
6. 缺少 create/start 事件。
7. 缺少可信 die/destroy 事件。
8. 容器 ID 与资源记录不一致。
9. 缺少 Execution ID。
10. Task cancelled 但 Docker 仍运行。
11. Git HEAD 发生未经授权的变化。

**预期：**

以上情况必须使实际验证器返回 FAIL 或明确未确认，并产生非零退出状态。

不得吞掉异常后使用默认空值制造成功。

注入后的失败必须来自实际验证器或与其共用的生产级判定逻辑。

**FAIL：**

任意关键证据异常仍返回测试成功。

**证据：**

故障注入方式、实际验证器退出码、错误日志及原始判定输入。

---

## B03-QA-06｜旧版失败与新版通过

**前置：**

固定旧版：

`f5252766e6c06a219d0f933e69cbefaaec739374`

新目标 Commit 已生成。

**测试：**

使用相同的核心故障输入与验收语义对比：

- B02 版本。
- B03 修复版本。

包括：

- No such object 后超时。
- 终止确认误报。
- 最终 Docker ps 查询失败。
- 最终 inspect 为 running。
- 缺少必要 Docker 事件。

**预期：**

旧版在已知缺陷条件下失败或错误通过，从而暴露缺陷。

新版必须给出正确的 Fail Closed 或测试失败结果。

不得删掉断言或通过改变测试目标制造通过。

**FAIL：**

测试不具备新旧版本区分能力，或者新版仍产生错误成功。

**证据：**

固定 SHA、相同故障输入、测试代码 Diff、两版运行日志。

---

## B03-QA-07｜完整安全回归与 CI

**前置：**

B03 修改完成，G0 契约已在开发前冻结。

**测试：**

运行：

- B03-QA-01～09 对应测试。
- B02-QA-01～10 回归。
- B01-QA-01～07 回归。
- 现有完整 Node 测试。
- SIGTERM/SIGKILL 真实测试。
- 真实 Docker 隔离测试。
- GitHub CI。
- 两份既有契约及新增契约完整性检查。

**预期：**

全部必要测试通过。

已有测试不得被删除或弱化。

CI 必须对应新固定 Commit。

CI SKIP 必须显式列出并以真实环境证据补足。

**FAIL：**

CI 失败、固定 SHA 不一致、冻结契约变化、断言弱化或以 SKIP 代替 PASS。

**证据：**

原始测试日志、CI URL、Commit SHA、测试数量、契约哈希和 Diff。

---

## B03-QA-08｜真实合法执行不回归

**前置：**

具备真实 Mac、Docker、Claude Code、GLM、Secure Enclave 和合法用户审批。

**测试：**

隔离测试仓库执行：

审批 → Claude Code → Verify → Git Commit → Ref 验证。

**预期：**

- Task = done。
- Execution = ok。
- Verify 通过。
- Git Commit 真实存在。
- Ref 正确。
- 授权修改范围正确。
- 凭据与模型令牌正常清理。
- 容器最终状态与真实 Docker 一致。

**FAIL：**

修复破坏正常合法执行，或者异常执行错误地进入成功路径。

**证据：**

脱敏真实审批、模型、Docker、Git 与 SQLite 记录。

不能用开发者口头声明或 Mock 替代必要的真实证据。

---

## B03-QA-09｜完整冻结契约继承与审计证据

**前置：**

开发完成，新固定 Commit 和全部证据可用。

**测试：**

逐项核对：

- AC-01～22。
- E2E-01～10。
- EV-01～15。
- B01-QA-01～07。
- B02-QA-01～10。
- B03-QA-01～09。

**预期：**

所有项目完整列出。

每项必须包含：

- 状态。
- 固定版本。
- 测试动作。
- 实际结果。
- 源码或原始证据。
- 证据等级。
- 缺失条件。

不得将模拟证据当成真实 Docker、Mac 或 OpenClaw E2E。

开发方不得自行宣布最终 PASS。

**FAIL：**

遗漏项目、证据来源混淆、隐藏失败、错误引用旧版本或未经独立验收宣布通过。

---

## 最终裁决规则

任意确定性阻断缺陷存在：FAIL。

没有确定性缺陷，但必要独立证据不足：OPEN / WAITING。

全部正式要求满足、证据充分：PASS。

B03 专项通过不代表整个 P0-SEC-01 自动通过。

只有原冻结 22 AC、10 E2E、15 EV 及适用补充验收全部满足，才能得到完整 PASS。

封版和合并 main 仍需用户批准。

本补充契约必须在代码开发前归档并冻结，不得事后调整。
