# B02 开发前冻结补充验收契约

契约编号：JARVIS-P0-SEC-01-B02-QA-v1.0  
状态：FROZEN｜2026-11-01，开发前  
对应工作包：JARVIS-P0-SEC-01-FIX3-CLOSE-B02

以下十项为本轮正式补充验收要求。

它们不修改原有 22 AC、10 E2E、15 EV，也不替代上一轮 B01-QA-01～07。

## B02-QA-01｜子进程错误语义

**前置条件：** 固定旧版和 B02 新版，目标 Node.js 运行时可用。

**测试动作：**

使用真实 execFile() 和生产 sh() 调用路径，分别注入或触发：

- 正常退出 0。
- 正常退出非零。
- 超时并收到 SIGTERM。
- 外部信号终止。
- 不存在的可执行文件。
- 输出超出 maxBuffer。
- 其他非空 Error 回调。

**预期：**

仅无错误且正常退出 0 的场景返回成功。

任何 Error 不得转换成 code=0 或 ok=true。

**FAIL：**

任何异常执行被归类为成功。

**证据：**

Node 版本、原始 Error、标准化结果、退出码、signal、独立运行日志、旧版失败/新版通过对照。

## B02-QA-02｜Claude、Verify、Audit 结果完整性

**前置条件：** 三种容器执行入口可用。

**测试动作：**

分别触发 Docker CLI 超时、异常退出、启动失败；同时测试正常成功退出。

**预期：**

- 异常不得返回成功的执行结果。
- Claude 不得因 CLI 超时错误进入正常成功路径。
- Verify 异常不得被当成通过。
- Audit 异常不得被当成成功审计。
- 需要 Verify/Commit 的任务不得因执行超时而越过原有门禁。
- 合法正常执行仍然成功。

**FAIL：**

异常执行导致 Task done、Execution ok、验证通过或未经满足条件的 Git Commit。

**证据：**

实际入口调用、Task/Execution 状态、验证输出、Git HEAD、异常日志。

## B02-QA-03｜TERM/KILL 超时不得产生假终止证明

**前置条件：** 资源处于 started、running 或 stopping。

**测试动作：**

控制 Docker TERM 与 KILL 返回：

- 成功。
- 非零失败。
- 超时 err.code=null。
- SIGTERM/SIGKILL 异常终止。
- 未知错误。

并分别组合 inspect=gone、running、exited、未知状态。

**预期：**

- 失败或超时的终止命令不能令 killAccepted=true。
- 未确认状态不得产生 confirmed=true。
- 已有独立可信物理停止证据时允许确认停止。
- 终止命令成功但容器仍运行时不得确认停止。

**FAIL：**

超时的 Docker kill 被误记为成功接受，或者单独的 gone 与不可信 kill 结果导致取消被确认。

**证据：**

终止命令结果、状态查询结果、killAccepted、confirmed、资源状态及取消返回值。

## B02-QA-04｜daemon 失联与未知 Docker 状态

**前置条件：** 存在真实或受控模拟的未终止 Execution。

**测试动作：**

测试：

- Docker info 超时。
- Docker inspect 超时。
- daemon 无法连接。
- 查询结果包含不完整 stdout/stderr。
- Docker 返回未知状态。
- 启动流程尚未完成时 inspect 返回 gone。
- 无资源登记的历史执行取消路径。

**预期：**

不能获得可信停止证据时必须 Fail Closed。

Task 不得错误标记 cancelled。

不得由错误的 Docker info 结果虚构 daemon 健康。

**FAIL：**

daemon 失联、超时或未知结果被当作已确认停止。

**证据：**

Docker 命令日志、Task/Execution/Resource 状态、真实或注入错误、重试行为。

## B02-QA-05｜执行资源终态一致性

**前置条件：** 存在启动中或已启动的 Docker 资源。

**测试动作：**

注入执行适配层正常返回、失败返回、超时与抛出异常；检查 launchContainer() 对资源状态的处理。

必要时使用真实 Docker 验证 CLI 终止与容器状态的差异。

**预期：**

- 确认停止才能写入 stopped。
- 未确认停止不得伪造资源终态。
- 取消操作不得利用错误状态提前返回成功。
- 状态不能被迟到回调覆盖成错误终态。

**FAIL：**

仅因 Docker CLI 抛错或结束，仍未确认真实容器状态就将资源标记为安全停止并据此确认取消。

**证据：**

资源状态转换记录、异常信息、Docker inspect/events、Task/Execution 状态。

## B02-QA-06｜真实 Docker 启动/取消竞态与残留证明

**前置条件：** 隔离测试 Docker 环境，使用唯一测试 Execution ID。

**测试动作：**

在 claimDockerInvocation() 获得许可后、真实 Docker 启动前设置确定性屏障。

调用取消，释放屏障，检查真实创建、运行、终止全过程。

**预期：**

- 取消不得提前成功。
- 实际发生过目标容器创建。
- 识别的容器 ID 与数据库 Execution 对应。
- 取消完成后目标容器真实终止。
- 不存在迟到副作用。
- Docker events、inspect、ps 与 SQLite 记录一致。
- Git HEAD 不发生未经授权的变化。

**FAIL：**

容器名称为空、undefined、与 Execution 不对应；没有真实生命周期证据却宣告通过；或实际存在迟到容器/副作用。

**证据：**

真实 Docker 原始日志、容器 ID、events、inspect、ps、SQLite、Git HEAD、测试时间顺序。

## B02-QA-07｜合法终止与 SIGKILL 升级

**前置条件：** 真实运行中的测试容器。

**测试动作：**

分别执行：

- 正常 SIGTERM 终止。
- 忽略 SIGTERM 后升级 SIGKILL。
- Docker 容器已独立确认退出。
- Docker 已停止但 CLI 返回异常。
- 取消重复调用。

**预期：**

能够确认实际停止的合法路径继续正常工作。

无法确认停止的路径保持未确认。

重复取消不得引入新 Execution 或错误终态。

**FAIL：**

修复造成正常取消全面失效，或者存在错误取消确认。

**证据：**

真实 TERM/KILL 结果、Docker 状态、Execution/Resource 状态、重复调用记录。

## B02-QA-08｜真实合法正向执行不回归

**前置条件：** 合法用户审批、真实 Docker、Claude Code、GLM 和可信验证配置。

**测试动作：**

在隔离测试仓库中完成：

审批 → 执行 → Verify → Git Commit → Ref 验证。

**预期：**

- Task = done。
- Execution = ok。
- Verify 成功。
- Commit 真实存在。
- Ref 指向正确 Commit。
- 修改文件在授权范围内。
- 容器资源全部正常结束。
- 凭据和令牌正常清理。

**FAIL：**

异常被误判为成功，或修复破坏正常合法执行。

**证据：**

脱敏真实执行日志、授权结果、Git 对象和 Ref、SQLite 状态、Docker 容器记录。

若无法获得真实 Mac/SE/GLM 环境，标记 WAITING，不得用 Mock 替代。

## B02-QA-09｜旧失败/新通过与 CI 质量

**前置条件：** G0 基线及新增测试已固定。

**测试动作：**

1. 在 d4d8795 上复现 DEF-01。
2. 在新固定 Commit 上使用同等条件测试。
3. 重跑 B01-QA-01～07。
4. 重跑原有安全测试与故障注入。
5. 运行真实 Docker 专项测试。
6. 在新固定 Commit 触发 GitHub CI。
7. 运行正式契约完整性检查。

**预期：**

- 旧版能暴露原问题。
- 新版通过同一失败条件。
- 不降低测试断言。
- 所有必需 CI 检查通过。
- SKIP 明确列出，不能冒充 PASS。
- 原正式契约与 G0 冻结补充契约均未修改。

**FAIL：**

无法复现旧缺陷、通过削弱测试制造成功、CI 未在新固定 SHA 运行、冻结契约变化或存在未解释的必需测试失败。

**证据：**

新旧测试日志、Commit、Diff、CI URL、测试统计、契约 SHA。

## B02-QA-10｜完整 P0 验收继承与证据交付

**前置条件：** B02 开发和测试完成。

**测试动作：**

按原冻结契约重新整理：

- 22 项 AC。
- 10 项 E2E。
- 15 项 EV。

并保留 B01-QA-01～07 与 B02-QA-01～10 的对应证据。

**预期：**

- 无遗漏。
- 每项有对应测试、代码或真实证据。
- 明确 PASS、FAIL、WAITING。
- 明确源码、CI、Mock、真实 SQLite/Git、真实 Docker、真实 Mac 与真实 OpenClaw 的差异。
- 无法完成的真实环境测试列出补证条件。
- 开发方不自行宣布正式 PASS。

**FAIL：**

漏掉原冻结验收项目、用模拟证据替代真实 E2E、掩盖 SKIP 或在证据不足时宣布完成。

**证据：**

完整验收映射矩阵、运行报告、证据包清单和哈希。
