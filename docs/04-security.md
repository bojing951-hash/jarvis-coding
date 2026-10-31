# 04 · 安全与权限

## 设计原则

个人助理只有一个信任边界（你本人）。因此不需要多租户隔离，但必须做到：**入口唯一、权限最小、凭据不落明文、管理面不出本机。**

## 工具面

本机最终配置：

```json
{
  "tools": {
    "profile": "messaging",
    "alsoAllow": ["group:fs", "group:memory"],
    "fs": { "workspaceOnly": true },
    "exec": { "mode": "deny" },
    "codeMode": false
  }
}
```

为什么不是 `full`：

| 配置 | 说明 |
|---|---|
| `messaging` 基线 | 只有消息与会话工具，**没有 shell、没有 web、没有 github** |
| `+ group:fs` | JARVIS 要写记忆文件，但配合下面一条被锁在 workspace 内 |
| `+ group:memory` | 记忆检索 |
| `fs.workspaceOnly: true` | 文件工具只能碰 `~/.openclaw/workspace`，读不到你的个人文件 |
| `exec.mode: deny` | 宿主命令完全禁止 |
| `codeMode: false` | **关键**：Code Mode 默认是 `auto`，会提供沙箱 JavaScript 执行；MVP 阶段关掉 |

> 注意 `tools.profile: "full"` 只是“选择全部工具”，不等于放权；但受限 profile 更省心。

## 实测验证（不是看配置，是看行为）

```bash
openclaw agent --agent jarvis --session-id "fresh-$(date +%s)" \
  --message "请实际调用 exec 工具执行 JavaScript；如果不存在请说明"
```

返回：

```text
Unknown tool id: exec
当前会话的工具配置中没有开放 exec / shell / 代码执行类工具。
```

⚠️ 同一个会话里问「你有什么工具」，模型可能凭上下文“回忆”出旧工具列表。**必须用新 session 做功能验证**，否则会误判。

## Gateway

| 项 | 配置 |
|---|---|
| 监听 | `127.0.0.1:18789`（loopback，IPv4+IPv6 均仅本机） |
| 认证 | token 模式 |
| Tailscale | `off` |
| 常驻 | LaunchAgent `ai.openclaw.gateway`，`RunAtLoad` + `KeepAlive` |

崩溃恢复实测：`kill -9` 掉进程后 **5 秒内自动拉起**，连通性检查 `ok`。

## 飞书侧

| 项 | 配置 |
|---|---|
| `dmPolicy` | `allowlist`，只含本人 open_id |
| `groupPolicy` | `disabled` |
| `allowBots` | `false`（防机器人互相刷屏） |
| 工具 | 仅 `chat`，文档/云盘/权限/表格全关 |

## 审计结果

```text
openclaw security audit
Summary: 0 critical · 2 warn · 1 info
```

两条 warn 及判断：

1. `gateway.trusted_proxies_missing` —— 网关只监听 loopback、没有反向代理，**不适用**。
2. `plugins.installs_unpinned_npm_specs` —— 插件未锁版本。需要时可用 `@openclaw/feishu@<版本>` 重装固定。

## 已知遗留（可接受，非阻断）

```text
openclaw secrets audit
plaintext=2
- openclaw.json:gateway.auth.token
- agents/jarvis/agent/openclaw-agent.sqlite:profiles.zai:default.key
```

两者所在文件权限均为 `0600`，且仅本机可读。若要进一步收敛，可把 Gateway token 也转成 SecretRef：

```bash
openclaw config set gateway.auth.token \
  --ref-provider default --ref-source store --ref-id OPENCLAW_GATEWAY_TOKEN
```

⚠️ 改错会导致 CLI 连不上网关，务必先备份 `openclaw.json`。

## 权限模式速查

| 模式 | 语义 |
|---|---|
| `deny` | 完全禁止宿主命令 |
| `allowlist` | 只跑白名单，其余静默拒绝 |
| `ask` | 白名单外需要人工批准 |
| `auto` | 自动评审 + 人工兜底 |
| `full` | 不做审批（不要用于对外暴露的会话） |
