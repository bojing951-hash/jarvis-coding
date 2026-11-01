# 24 · P0-SEC-01-FIX3-CLOSE-B04 开发与证据报告

> 状态：**DEVELOPMENT_DELIVERED / READY_FOR_INDEPENDENT_AUDIT**  
> 不宣布正式验收 PASS。G3 独立验收未开始。  
> 固定基线：`0a1828069f1dfdf913d0a5f917cb9ba910a90f69`  
> G0 补充契约 Commit：`1fdd64533dbb097356615b13f6afc1334bb154c8`  
> 实现目标 Commit：`3db619963eaf1deae2e69f556893c3ec95242e42`  
> 分支：`fix/p0-sec-01-b04`

## 1. 固定输入与 G0

| 项 | 值 |
|---|---|
| 仓库 | `bojing951-hash/jarvis-coding` |
| 固定基线 | `0a1828069f1dfdf913d0a5f917cb9ba910a90f69`（B03 最终 HEAD） |
| 开发分支 | `fix/p0-sec-01-b04` |
| 原 P0 契约 | `docs/contracts/p0-sec-01-ac-v1.0.md` |
| 原契约 SHA-256 | `af15737713c554509612d8296aee148387649f0ebf8b0644d933ecf8b40691b0` |
| B02 契约 | `docs/contracts/p0-sec-01-b02-qa-v1.0.md` |
| B02 SHA-256 | `6078386fc3554813956bf8e7f38d5ccaa324c65d03fc1ae9871088cb2c10d940` |
| B03 契约 | `docs/contracts/p0-sec-01-b03-qa-v1.0.md` |
| B03 SHA-256 | `27c0d284508e177c25188453dd5e79a912a2e83d94dc4a24fd26847486e0ca6b` |
| B04 契约 | `docs/contracts/p0-sec-01-b04-qa-v1.0.md` |
| B04 SHA-256 | `2c02e53e23bf4b23a57a5db10220f60ef6488737badd466abbe628dfc826741b` |
| B04 契约字节数 | 7,516 bytes；B04-QA-01～08 |
| B04 冻结 Commit | `1fdd64533dbb097356615b13f6afc1334bb154c8` |
| Node（本机） | v24.13.1 |
| Docker | 29.9.2 |
| macOS | 15.6.1 / Apple M4 |

G0 在代码修改前完成：基线核对、三份既有契约哈希核对、B04 契约冻结、独立分支创建、环境检查。`main` 与四份契约在开发中均未修改。

## 2. B03-G3-EV-02 旧版假阳性

### 2.1 事件顺序、ID、时间均未验证

旧验证器只接收 Action 字符串数组，检查：

```js
['create', 'start', 'die', 'destroy'].every(a => events.includes(a))
```

在固定基线 `0a18280` 上运行旧 `evaluateDockerRaceEvidence()`：

```json
{
  "case": "reverse-actions",
  "events": ["destroy", "die", "start", "create"],
  "validation": { "ok": true, "failures": [] }
}
```

```json
{
  "case": "no-event-identity-or-time",
  "events": ["create", "start", "die", "destroy"],
  "validation": { "ok": true, "failures": [] }
}
```

即：

- 完全倒序仍 PASS；
- 没有任何 `Actor.ID`、容器名称、`timeNano` 仍 PASS；
- 验证器只检查 `containerId` 非空，未检查事件 ID 与真实容器 ID 一致；
- 事件被 `Set` 去重，重复/混杂事件无法复核；
- 没有取消确认时间与 die 的时间关系。

### 2.2 旧真实脚本的同类缺陷

旧脚本的 `events` 采集只保留 `{{.Action}}`，`events` 被去重；最终判定没有纳入事件 ID、时间、顺序。B03 已证明 `docker ps` 失败仍 exit 0；B04 继续关闭事件层的同类证据缺陷。

## 3. 修复内容

### 3.1 结构化 Docker JSON Lines

脚本改为在启动屏障释放前启动真实事件监听：

```bash
docker events --filter type=container --format '{{json .}}'
```

按原始顺序保存每条 JSONL，不再降维为 Action 集合，不再用 `Set` 去重。

解析后的每条事件：

```js
{
  type: 'container',
  action: 'create' | 'start' | 'die' | 'destroy' | ...,
  actorId: '<Actor.ID>',
  actorName: '<Actor.Attributes.name>',
  timeNano: '<原始十进制字符串>',
  raw: '<原始 JSON 行>'
}
```

`timeNano` 从原始 JSON 行用正则提取，避免 JSON Number 超过 `Number.MAX_SAFE_INTEGER` 后丢精度；比较使用 `BigInt`。

### 3.2 真实容器身份绑定

验证器要求：

- `containerId` 是完整 64 位 Docker ID；
- 所有必需事件的 `Actor.ID` 精确等于该 ID；
- 所有必需事件的 `Actor.Attributes.name` 等于 Resource/容器名；
- Resource 名等于 `jarvis-exec-<executionId>`；
- Event Type 为 `container`；
- 其他容器的必需事件不得混入。

脚本不再只依赖 `--filter container=<name>` 的名称过滤；最终事实由事件自身的 `Actor.ID` 与 `Actor.Attributes.name` 校验。

### 3.3 单次生命周期顺序与时间

对目标容器的必需事件：

- 每个动作必须恰好出现一次；
- 原始记录顺序必须为 `create → start → die → destroy`；
- `timeNano` 必须为合法正整数字符串；
- BigInt 时间必须非降序；
- `destroy` 后不得再有目标容器事件；
- 额外正常事件（attach/kill 等）允许存在于必需事件之间。

### 3.4 取消时间关系

计时字段：

```text
startedAt / barrierAt / cancelRequestedAt / releaseAt
cancelResolvedAt / finalStateAt
```

验证：

- `barrierAt >= startedAt`；
- `cancelRequestedAt >= barrierAt`；
- `releaseAt >= cancelRequestedAt`；
- `cancelResolvedAt >= releaseAt`；
- `finalStateAt >= cancelResolvedAt`；
- `create/start` 发生在 `releaseAt` 之后、`finalStateAt` 之前；
- `die <= cancelResolvedAt`；
- `destroy <= finalStateAt`；
- `destroy` 后无目标事件；
- Task/Execution/Resource 与 Git HEAD 不变。

Docker daemon 与宿主机使用同一时钟基准；本测试不使用人为时间容差。无法比较时 Fail Closed。

### 3.5 共用验证器

`evaluateDockerRaceEvidence()` 现在直接检查结构化事件，并校验：

- events 查询成功；
- 原始 JSONL 非空且可解析；
- 原始 JSONL 数量与解析事件一致；
- 容器 ID/名称/Type 一致；
- 必需动作完整且顺序正确；
- 时间戳存在、合法、顺序正确；
- 取消时间关系正确；
- `docker ps`/最终 `inspect` 可信；
- SQLite 状态与 Git HEAD 一致。

任何必要条件失败都返回明确 `failures`，不再使用笼统的 `eventsOk=true` 代替内容验证。

## 4. B04-QA-01～08 结果

| 编号 | 状态 | 证据 |
|---|---|---|
| B04-QA-01 原始信息完整性 | **PASS** | `docs/24-b04-events.jsonl` 7 行原始 JSONL；Type/Action/Actor.ID/name/timeNano 完整；SHA 见第 5 节 |
| B04-QA-02 真实容器身份绑定 | **PASS** | 真实事件 ID 全部等于容器 ID；名称等于 Resource/Execution；负向混合容器/错误 ID/错误名称全部 FAIL |
| B04-QA-03 生命周期顺序与时间 | **PASS** | 真实 create/start/die/destroy；倒序/部分倒序/时间逆序/缺失/非法/重复/拼接全部 FAIL |
| B04-QA-04 取消时间与物理生命周期 | **PASS** | die 早于取消成功；create/start 晚于屏障释放；destroy 早于最终查询；无迟到目标事件 |
| B04-QA-05 共用验证器反向测试 | **PASS** | 39 项 B03/B04 验证器反向测试 + 12 项 B04 事件测试；全部调用同一函数 |
| B04-QA-06 旧失败与新通过 | **PASS** | 旧版反转 Action 数组仍 PASS；新版结构化反转 FAIL；旧版无 ID/时间仍 PASS；新版缺失 ID/时间 FAIL |
| B04-QA-07 真实 Docker 与完整回归 | **PASS** | 182/182 本机；SIGKILL 6/6；Docker isolation 2/2；真实 Docker 竞态 2/2；CI 182/179/3 |
| B04-QA-08 正式 P0 验收继承与证据边界 | **PASS（映射完整）** | 第 7 节完整映射；明确 A-G 证据等级与 WAITING；未宣布正式 PASS |

## 5. 真实 Docker JSONL 与时间线

原始证据文件：

```text
docs/24-b04-events.jsonl
7 行，6,104 bytes
SHA-256: e9cdb0eb1cbc881dc259a98f1630d4f9770b886e9cd627c674bc882f7d733ad9
```

必需事件原始字段（节选，完整行见文件）：

```json
{"Type":"container","Action":"create","Actor":{"ID":"5b2e46e7506ee813f7a3107ace32abbf2df88e43a8f8031b1a5ee96a0814d388","Attributes":{"name":"jarvis-exec-exe_mvxha08h05f9nt"}},"timeNano":1793516267167636801}
{"Type":"container","Action":"start","Actor":{"ID":"5b2e46e7506ee813f7a3107ace32abbf2df88e43a8f8031b1a5ee96a0814d388","Attributes":{"name":"jarvis-exec-exe_mvxha08h05f9nt"}},"timeNano":1793516267372791218}
{"Type":"container","Action":"die","Actor":{"ID":"5b2e46e7506ee813f7a3107ace32abbf2df88e43a8f8031b1a5ee96a0814d388","Attributes":{"name":"jarvis-exec-exe_mvxha08h05f9nt"}},"timeNano":1793516272660308429}
{"Type":"container","Action":"destroy","Actor":{"ID":"5b2e46e7506ee813f7a3107ace32abbf2df88e43a8f8031b1a5ee96a0814d388","Attributes":{"name":"jarvis-exec-exe_mvxha08h05f9nt"}},"timeNano":1793516272681131012}
```

实际事件顺序（原始 JSONL）：

```text
create → attach → start → kill(SIGTERM) → kill(SIGKILL) → die → destroy
```

容器对照：

| 项 | 值 |
|---|---|
| Execution ID | `exe_mvxha08h05f9nt` |
| Resource name | `jarvis-exec-exe_mvxha08h05f9nt` |
| Container ID | `5b2e46e7506ee813f7a3107ace32abbf2df88e43a8f8031b1a5ee96a0814d388` |
| Container name | `jarvis-exec-exe_mvxha08h05f9nt` |
| 实际运行 State | `created` → `running` → `removing` |
| 最终 inspect | normal `No such object: jarvis-exec-exe_mvxha08h05f9nt`，`trustedGone=true` |
| docker ps -a | command ok，stdout 空 |

时间线（host ms 与 Docker `timeNano` 换算）：

| 节点 | 时间 |
|---|---|
| 测试开始 startedAt | 1793516265332 |
| 启动屏障 barrierAt | 1793516266982 |
| 取消请求 cancelRequestedAt | 1793516266982 |
| 屏障释放 releaseAt | 1793516267032 |
| Docker create | 1793516267167 |
| Docker start | 1793516267372 |
| Docker die | 1793516272660 |
| Docker destroy | 1793516272681 |
| 取消成功 cancelResolvedAt | 1793516272734 |
| 最终状态查询 finalStateAt | 1793516310472 |

结论：

- `create/start` 晚于 release；
- `die` 早于 cancelResolved 约 74ms；
- `destroy` 早于 cancelResolved 约 53ms；
- `destroy` 早于 finalState；
- `die`（已停止）与 `destroy`（已销毁）分别验证；
- `destroy` 后无目标事件；
- Task/Execution/Resource 与 Git HEAD 一致。

## 5.1 真实正向执行（B04）

真实 Claude Code + Docker + GLM + 生产 Secure Enclave 审批：

```text
task: tsk_mvxhfy0t03x4f9
execution: exe_mvxhg0qh07i949
taskStatus: done
executionStatus: ok
commitSha: 4b2f5b6b41ffd72e047fff56fc7e7d4f999fa70b
refVerified: true
changed: ["feature.txt"]
verify: exitCode 0, output "FEATURE_OK"
resources: claude stopped, verify stopped
token file: {}
```

B04 只修改验证器/测试脚本，不修改生产执行、审批或状态机；该真实执行用于证明修复没有破坏合法执行。

## 6. B04-QA-06 旧失败/新通过

语义映射：

| B03 旧格式 | B04 新格式 |
|---|---|
| `events: ['create',...]` | `events: [{type,action,actorId,actorName,timeNano,raw}]` |
| 无 Actor.ID | 每条必需事件必须绑定 Container ID |
| 无 timeNano | 每条必需事件必须有可信时间戳 |
| 无原始顺序保证 | 保留原始 JSONL 顺序 |
| 无取消时间关系 | 明确 started/barrier/cancel/release/resolved/final |

旧版固定 `0a18280`：

- 反转 Action 数组 → `ok=true`；
- 无事件 ID/时间 → `ok=true`；
- 无法区分其他容器事件。

新版固定 `3db6199`：

- 同一语义的反转结构化事件 → `FAIL`；
- 缺失/非法/逆序时间 → `FAIL`；
- 混合其他容器 ID/名称 → `FAIL`；
- 正常结构化生命周期 → `PASS`。

旧版日志：`/tmp/b04-old-validator.log`。  
新版测试：`orchestrator/test/b03-validator.test.mjs` 39 项、`orchestrator/test/b04-events.test.mjs` 12 项，全部直接调用共用验证器。

## 7. AC / E2E / EV 与 B01/B02/B03/B04 映射

证据等级：

- **A** GitHub 源码 / Diff。
- **B** GitHub CI。
- **C** 独立故障注入测试。
- **D** 真实 SQLite / Git 集成。
- **E** 真实 Docker。
- **F** 真实 Mac / SE / Claude / GLM。
- **G** 真实 OpenClaw / MCP / Workflow（本轮缺失）。

### 22 AC

| AC | 状态 | 等级 | 证据 / 缺失 |
|---|---|---|---|
| AC-01 固定版本/范围 | PASS | A/B | 基线 0a18280、G0 1fdd645、目标 3db6199、main 未改 |
| AC-02 MCP 无未授权 Shell | PARTIAL | C | 配置/注入；缺 live MCP（G） |
| AC-03 命令注入防护 | PASS | A/C | security.test AC-01/AC-08 |
| AC-04 可信验证配置 | PASS | A/D | 签名登记 + 配置测试 |
| AC-05 真实人工审批 | PASS | F | 生产 SE 签名 + 真实审批 E2E |
| AC-06 审批内容绑定 | PASS | C/D | digest/profile 测试 |
| AC-07 审批过期/重放 | PASS | C | 挑战/复用测试 |
| AC-08 全入口共用门禁 | PARTIAL | C | 配置/工作流；缺 live MCP（G） |
| AC-09 项目目录限制 | PASS | C | AC-04 路径测试 |
| AC-10 路径穿越/符号链接 | PASS | C | AC-10 测试 |
| AC-11 外部执行器限制 | PASS | E | 真实 Docker + risk01 |
| AC-12 合法写入正向 | PASS | F | 真实 Claude E2E |
| AC-13 测试失败阻止 Commit | PASS | D | AC-13 真 git 测试 |
| AC-14 缺少校验不得提交 | PASS | C | AC-14 测试 |
| AC-15 提交范围 | PASS | D | AC-05 提交范围测试 |
| AC-16 成功提交真实证据 | PASS | D/F | 真实 Commit/Ref |
| AC-17 取消后无副作用 | PASS | E/D | B04 真实 Docker + B03/B02 |
| AC-18 取消失败不虚报 | PASS | E/C | B04 时间线 + B03 inspect/终止测试 |
| AC-19 并发/重复 | PASS | C/D | B01 并发/审批归属 |
| AC-20 暂停/失败/重启 | PARTIAL | C | 重启终态 6/6；缺提交中断自动恢复 |
| AC-21 执行证据完整 | PASS | E/D/A | JSONL + ID/顺序/时间 + SQLite/Git |
| AC-22 无阻断回归 | PARTIAL | B/C | 182 项套件；缺 live OpenClaw（G） |

### 10 E2E

| E2E | 状态 | 等级 | 证据 / 缺失 |
|---|---|---|---|
| E2E-01 未授权 Shell 拒绝 | PARTIAL | C | 单元/配置；缺 live MCP |
| E2E-02 伪造审批拒绝 | PASS | F | PRE-A02 |
| E2E-03 真实审批后合法执行 | PASS | F | 真实 Claude E2E |
| E2E-04 测试失败阻断提交 | PASS | D | AC-13 |
| E2E-05 无关文件不进 Commit | PASS | D | AC-15 |
| E2E-06 跨项目/路径逃逸 | PASS | C | AC-04/AC-10 |
| E2E-07 取消竞态 | PASS | E/D | B04 真实 Docker 时间线 |
| E2E-08 Workflow 权限绕过 | PARTIAL | C | 配置；缺 live workflow |
| E2E-09 审批绑定/重放 | PASS | F/C | PRE-A03/挑战测试 |
| E2E-10 非编程工作流回归 | PARTIAL | C | smoke/单元；缺 live OpenClaw |

### 15 EV

| EV | 证据 |
|---|---|
| EV-01 固定基线/目标 | 第 1 节 + G0 Commit |
| EV-02 完整 Diff | `docs/24-b04.diff` |
| EV-03 修改文件清单 | 第 9 节 |
| EV-04 安全执行调用链 | 第 2–3 节 + 源码 |
| EV-05 审批机制/可信来源 | 既有报告 + 第 7 节 |
| EV-06 Shell 注入负向 | security.test AC-01/AC-08 |
| EV-07 未授权写入负向 | PRE-A02/AC-02 |
| EV-08 跨项目/路径逃逸 | AC-04/AC-10 |
| EV-09 测试失败阻断 Commit | AC-13 |
| EV-10 合法执行/验证/Commit | 第 7 节真实 E2E |
| EV-11 Git 提交范围 | AC-15 |
| EV-12 取消/并发竞态 | JSONL + 时间线 + SIGKILL |
| EV-13 原有功能回归 | 182/182；CI 182/179/3 |
| EV-14 执行状态/审计记录 | Docker events + SQLite |
| EV-15 环境限制/风险/回滚 | 第 10–11 节 |

### B01 / B02 / B03 / B04

| 组 | 状态 | 证据 |
|---|---|---|
| B01-QA-01～07 | PASS | 7/7 回归；真实 Docker/SIGKILL/正向 |
| B02-QA-01～10 | PASS | 21/21 回归；真实 Docker/正向 |
| B03-QA-01～09 | PASS | 14/14 inspect + 39 验证器；真实 Docker |
| B04-QA-01～08 | PASS（映射） | 12/12 B04 事件 + 39 验证器；真实 JSONL |

B04-QA-08 只代表映射完整，不代表整体 P0 PASS；AC-02/08/20/22、E2E-01/08/10 仍为 PARTIAL/WAITING。

## 8. 测试与 CI

本机：

```text
node --test orchestrator/test/*.test.mjs
tests 182 / pass 182 / fail 0 / skipped 0
```

B04 专项：12/12。  
B03 验证器/回归：39/39 + 14/14。  
B02 回归：21/21。  
B01 回归：7/7。  
SIGKILL：6/6。  
Docker isolation：2/2。  
真实 Docker 竞态：2/2（结构化 JSONL）。

GitHub Actions（实现 Commit `3db6199`）：

- Run: https://github.com/bojing951-hash/jarvis-coding/actions/runs/41283110947
- `unit + fault-injection` success
- `contract integrity` success
- Node v24.22.1

```text
tests 182 / pass 179 / fail 0 / cancelled 0 / skipped 3
```

3 个 skip 全部是 CI 无执行器镜像的显式 Docker skip：

- Docker 验证容器实际执行；
- Docker 审计/验证只读挂载；
- FIX3-D 只读挂载。

本机已真实执行；未以 skip 冒充 PASS。

## 9. 修改文件与 Diff

```text
docs/contracts/p0-sec-01-b04-qa-v1.0.md       （G0 冻结，360 行）
orchestrator/scripts/b03-docker-evidence.mjs
orchestrator/scripts/verify-b01-docker-race.mjs
orchestrator/test/b03-validator.test.mjs
orchestrator/test/b04-events.test.mjs
```

完整 Diff：`docs/24-b04.diff`（`0a18280..3db6199`，1,101 行）。  
原始事件：`docs/24-b04-events.jsonl`（7 行，SHA-256 `e9cdb0eb…`）。

## 10. 未验证事项、风险与回滚

### 未验证 / WAITING

1. AC-02/AC-08/E2E-01/E2E-08：未重跑 live MCP/Workflow。
2. AC-20：未实测“提交中断后自动恢复”。
3. AC-22/E2E-10：未重跑 live OpenClaw 非编程工作流。
4. 真实 Audit 模型调用未重跑；Audit 生命周期由 B01-C + 真实只读挂载测试覆盖。
5. CI 不执行真实 Docker；3 个 skip 已披露。

### 风险

- Docker 事件监听在屏障释放前启动；若监听失败，`eventsOk=false`，测试 FAIL。
- 事件 `Actor.ID`/`Attributes.name` 格式随 Docker 版本变化时 Fail Closed。
- 事件时间与宿主机时间使用同一时钟基准；无证据时不使用容差。
- 事件监听等待 destroy 上限 4 秒；超时后测试 FAIL，不假定 destroy 发生。
- 脚本最终状态查询可能因轮询耗时较长；不影响时间关系，但增加运行时间。
- 其他容器若有 create/start/die/destroy，会触发 foreign 事件 FAIL；测试环境应隔离。
- Orchestrator 在 starting 状态崩溃 → unknown，不会自动视为停止。

### 回滚

```bash
git checkout fix/p0-sec-01-b04
git reset --hard 0a1828069f1dfdf913d0a5f917cb9ba910a90f69
docker rmi jarvis-b01-exec:test
```

B04 契约不得在开发中修改；回滚会一并移除 B04 契约与修复。

## 11. 门禁结论

| 门禁 | 状态 |
|---|---|
| G0 开发准备/契约冻结 | 通过（1fdd645） |
| G1 旧失败/新通过 | 通过（旧版反转/无 ID/时间仍 PASS；新版对应 FAIL） |
| G2 自动质量 | 通过（182/182 本机；CI 182/179/3；真实 Docker/Mac） |
| G3 独立验收 | 未开始 |
| 正式 PASS | **未宣布** |

**本工作包：`READY_FOR_INDEPENDENT_AUDIT`。**

开发方不自行宣布正式 PASS；AC-02/08/20/22 与 E2E-01/08/10 的 PARTIAL/WAITING 状态由 Agent 2 独立裁决。
