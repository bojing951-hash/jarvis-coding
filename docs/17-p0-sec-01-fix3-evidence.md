# 17 · P0-SEC-01-FIX3 证据包

> 状态：**DEVELOPMENT_DELIVERED / PENDING_INDEPENDENT_AUDIT**
> 其中 FIX3-A 的「OS 保护私钥」受环境限制为 **WAITING**，其余已实现并测试。

## 固定版本

| 项 | 值 |
|---|---|
| 修复起点（FIX2 失败版本） | `f626e82c5e099e43c407ad338bf2cbad5d02120a` |
| 分支 | `fix/p0-sec-01-fix3` |
| 契约 | 从固定 Commit 读取，21297 bytes，`af157377…91b0`，22/10/15 |
| `main` | 未改动 |

## 缺陷修复

| 编号 | 修复 | 测试 |
|---|---|---|
| FIX3-A 审批证明 | 一次性挑战 + 服务端验签（`buildApprovalPayload` / `verifyApprovalSignature` / `consumeAuthChallenge`）；CLI 不再以退出码为授权依据 | 6 项（合法/篡改/缺公钥/助手伪造/重放/跨任务） |
| FIX3-B 原子消耗 | 授权校验 + 状态抢占 + `used_at` 消耗置于同一 `BEGIN IMMEDIATE` 事务 | `approval_consumed` 分支 |
| FIX3-C 生命周期 | 新增 `execution_resources` 表，登记 claude/verify/audit 容器；取消按资源登记执行；重试上限只在 `pending/approved/retry_pending` 生效 | 资源取消测试 |
| FIX3-D 审计只读 | 审计容器 `:ro` 挂载，独立 `/tmp` | 真实 Docker 写入被拒 |
| FIX3-E Docker 状态 | 未知状态 → `unknown_container_state`（不再默认判停止） | 注入测试 |
| FIX3-F 代理授权 | 模型请求需执行级令牌 `/api/anthropic/s/<token>/...`；宿主维护 token 表，过期失效；无令牌 401 | 代理拒绝路径 |
| 附加 | 删除未调用且引用未定义变量的 `runIsolated` | 静态检查 |

## 真实 Docker 证据

```text
只读挂载：容器内 echo > /work/... → WRITE_BLOCKED
代理鉴权：无令牌请求 → HTTP 401，日志 [model-deny]
网络：容器直连厂商 BLOCKED；经代理可访问
```

## 测试

```text
node --test orchestrator/test/*.test.mjs
tests 71 / pass 71 / fail 0
```

## 真实场景验证（本轮补做）

`node orchestrator/scripts/verify-cancel-sigkill.mjs` → **6/6 PASS**（真实 Docker）

```text
PASS 启动忽略 SIGTERM 的容器
PASS 取消升级到 SIGKILL（6281ms，SIGTERM 无效后升级）
PASS 取消结果确认为已终止
PASS 容器已停止（exited）
PASS 任务状态为 cancelled
PASS 新进程读到终态且拒绝重复执行（terminal_state）
```

**真实模型执行（令牌路径）**

```text
代理日志  [model] exec=exe_mvwlpb1m01tk62 POST /api/anthropic/v1/messages
容器内    带令牌 → HTTP 200（真实 GLM 响应）
          无令牌 → HTTP 401
任务结果  ok=true，Claude Code 正确回答仓库导出函数
```

## CI

`.github/workflows/ci.yml`：Node 24 跑全部单元/注入测试，并校验冻结契约大小与 SHA-256。
真实 Docker 挂载测试在无执行器镜像的环境自动 skip。

## FIX3-A 的阻断（必须记录）

生产环境 `jarvis-auth keygen` 返回：

```text
NSOSStatusErrorDomain Code=-34018
failed to add key to keychain
```

`-34018` = `errSecMissingEntitlement`：数据保护钥匙串 / Secure Enclave 的 user-presence 访问控制
要求可执行文件带 Apple 签名身份与相应 entitlement。本机没有 Apple Developer 签名身份，
命令行工具无法获得该 entitlement。

因此：
- 验签、挑战、防重放、原子消耗**已实现并有测试**；
- 但**生产密钥无法生成**，`approve` 在真实环境会 fail closed（拒绝授权），不会回退到 TTY；
- 相应地，写模式真实 E2E 在当前环境**无法执行** → 标记 **WAITING**。

解决路径（需用户决定）：
1. 用 Apple Developer ID 对 helper 签名并添加 `keychain-access-groups` entitlement；
2. 或改用带签名的 App（如已有的 JARVIS 桌面端）承载审批；
3. 或由用户明确接受「软件密钥 + 本地文件保护」这一较低保证（本轮未采用，因契约要求不可导出密钥）。

## 已知限制

- AC-18 顽固进程未实测；
- AC-20 重启逐条未实测；
- 模型代理令牌写入 `~/.openclaw/jarvis/proxy/active-tokens.json`（0600），宿主控制面可读。

## 回滚

```bash
git checkout fix/p0-sec-01-fix2
git branch -D fix/p0-sec-01-fix3
```
