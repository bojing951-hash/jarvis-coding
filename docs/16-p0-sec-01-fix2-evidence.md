# 16 · P0-SEC-01-FIX2 证据包

> 状态：**DEVELOPMENT_DELIVERED / PENDING_INDEPENDENT_AUDIT**
> 本文只记录可复核的事实与命令输出，不构成验收结论。

## 固定版本

| 项 | 值 |
|---|---|
| 修复起点（失败版本） | `fd5de37b91e369a0e17146b815f0d93f4129a619` |
| 分支 | `fix/p0-sec-01-fix2` |
| 冻结契约 | `docs/contracts/p0-sec-01-ac-v1.0.md`（从上述 Commit 读取，21297 bytes，sha256 `af157377…91b0`，22/10/15 计数一致） |
| `main` | 未改动 |

## 八项缺陷修复

| 缺陷 | 修复 | 位置 | 测试 |
|---|---|---|---|
| DEF-01 取消确认不可靠 | `killContainer` 先探测 daemon，再区分 `exited/dead/gone`、`container_still_running`、`docker_daemon_unreachable`；daemon 失联一律 `confirmed=false` | `isolation.mjs:killContainer` | `docker-fault.test.mjs` 3 项 |
| DEF-02 验证容器不受控 | 校验容器命名 `jarvis-verify-<execId>`，与执行容器同属一个 Execution；取消时逐个终止并汇总，daemon 失联则整体不确认 | `isolation.mjs:runInWorkdir`、`service.mjs:cancelTask` | `docker-fault.test.mjs` 取消覆盖两条 kill |
| DEF-03 网络 Fail Closed | `Internal !== 'true'` 直接 `available=false`；网络不存在同样拒绝 | `isolation.mjs:isolationStatus` | 3 项（含 Internal=false） |
| DEF-04 审批身份 | 新增 Swift 助手调用 macOS LocalAuthentication（`deviceOwnerAuthentication`）；CLI 审批与校验配置登记都必须通过系统认证；TTY/固定字符串不再参与 | `orchestrator/darwin/approve-helper.swift`、`security.mjs:runMacAuth`、`cli.mjs` | 4 项（缺失/拒绝/超时/CLI 必须用 runMacAuth） |
| DEF-05 审批门禁统一 | `runTask` 顶部旧 `approved_at` 检查只作用于非执行器任务；执行器只认 `approvals` 表 | `service.mjs:runTask` | 2 项 |
| DEF-06 Ref 发布传播 | 发布后 `git rev-parse <ref>` 复核 SHA；发布失败 → 裁决 failed；工作树保留并记 `worktree.preserved` 事件 | `service.mjs`、`executor.mjs:revParseRef` | 2 项 |
| DEF-07 审计入口隔离 | `runAuditTask` 改为容器内 `plan` 模式 + 固定 commit 工作树，审计后校验工作树仍干净 | `service.mjs:runAuditTask` | 工作树干净断言 |
| DEF-08 终态保护 | 终态（done/cancelled/cancel_failed）先于重试上限判断；agent/executor 路径均用条件更新；新增显式 `task retry` | `service.mjs:runTask`、`retryTask` | 3 项 |

## RISK-01 凭据暴露核验（真实 Docker）

`node orchestrator/scripts/verify-risk01.mjs` → **10/10 PASS**

```text
PASS 宿主侧密钥仅存在于 0600 文件
PASS 宿主代理在隔离网络内可达
PASS 容器内文件与环境不含真实密钥（仅占位符）
PASS docker inspect 不含真实密钥
PASS 容器不能直连模型厂商（无外网路由）
PASS 受控代理接受模型路径（HTTP 400 = 已到达上游校验）
PASS 代理拒绝非白名单路径（HTTP 403）
PASS 校验容器默认无凭据挂载
PASS 代码仓库不含真实密钥
PASS 网关日志不含真实密钥
```

实现变更：容器不再持有 API Key。`ANTHROPIC_BASE_URL` 指向宿主代理 `http://<proxy>:8888/api/anthropic`，
容器内仅有占位符 `ANTHROPIC_API_KEY=proxy-managed-placeholder`；真实密钥由代理注入 Authorization 头，
只存在于宿主 `~/.openclaw/jarvis/proxy/glm.key`（0600）。

## 真实执行证据

**写闭环（macOS 认证后）**

```text
approval  经 LocalAuthentication（系统日志 23:37:43 发生 UI 交互）
isolated  true    network jarvis-internal
verify    exit 0
changed   ["src/calc.mjs"]  outside []
commit    417e93d25ef4
ref       refs/heads/jarvis/tsk_mvwkepyv01youd  published=true  verified=true
verdict   done
```

**测试失败阻断（E2E-04 真实重跑）**

```text
verify exit 1 → commit skipped（reason=校验失败）→ task failed → API ok=false
仓库 HEAD 保持 6e0f38c，无新提交
```

## 测试

```text
node --test orchestrator/test/*.test.mjs
tests 63 / pass 63 / fail 0
```

含：既有回归、FIX1 安全用例、FIX2 新用例（`fix2.test.mjs` 11 项、`docker-fault.test.mjs` 7 项）。

Docker 失败注入使用**可控 docker 替身**（真实文件、真实调用），覆盖：daemon 失联、容器消失、容器仍在、网络 Internal=false/不存在。

## E2E 状态

| E2E | 状态 | 证据 |
|---|---|---|
| E2E-01 未授权 Shell | PASS（单测） | 白名单拒绝 + 无副作用 |
| E2E-02 伪造审批 | PASS（单测） | `approved=true` 非法；伪 TTY 不再授权 |
| E2E-03 合法写入 | PASS（真实） | commit `417e93d` + ref 复核 |
| E2E-04 失败阻断 | PASS（真实） | 见上 |
| E2E-05 无关文件 | PASS（设计+单测） | 工作树初始干净 + 路径白名单 |
| E2E-06 跨项目/逃逸 | PASS（单测） | 含符号链接 |
| E2E-07 取消竞态 | PASS（真实 + 注入） | 容器确认、daemon 失联不误报 |
| E2E-08 Workflow 绕过 | PASS（单测） | 同源校验 |
| E2E-09 绑定与重放 | PASS（单测） | 摘要变更失效、used_at |
| E2E-10 非编程工作流 | PASS（上一轮真实） | 3 节点 done |

## 已知限制

1. **审批需要用户在场**：`deviceOwnerAuthentication` 会弹系统认证。无人操作时助手返回 `code=3`，审批保持拒绝——这是设计意图，不是缺陷。
2. **AC-18 顽固进程**：SIGTERM→SIGKILL 升级已实现，但未用「忽略 SIGTERM 的容器内进程」实测。
3. **AC-20 重启场景**：状态门禁与原子更新已实现，重启后的逐条实测未全部覆盖。
4. **代理容器的密钥文件**：宿主上存在一份 0600 明文密钥供代理读取；这是宿主侧受控存储，未进入容器、镜像、Git 或日志。

## 回滚

```bash
git checkout fix/p0-sec-01-fix1
git branch -D fix/p0-sec-01-fix2
```

镜像/网络/代理不受代码回滚影响；如需一并清理：
`docker rm -f jarvis-proxy; docker network rm jarvis-internal`
