# 贾维斯编程 · JARVIS × OpenClaw 部署配置

把 **飞书 → OpenClaw → GLM** 这条链路在本机跑通的完整、可复现的配置与验收记录。

手机上的飞书私聊就是入口：JARVIS 负责对话、记录想法、维护长期记忆，未来再挂接 Claude Code、Codex 等专业 Agent。

> 本仓库只包含**配置与人设**，不含任何 API Key、Gateway Token、App Secret、聊天记录或会话数据库。

## 架构

```text
iPhone 飞书  ──WebSocket 长连接──▶  OpenClaw Gateway (127.0.0.1:18789)
                                          │
                                          ├─ Agent: JARVIS（中文、结论先行）
                                          ├─ 模型: zai/glm-5.3（智谱 Coding Plan CN）
                                          └─ 记忆: workspace 内 Markdown + 关键词索引
```

## 当前实测状态

| 项目 | 状态 | 证据 |
|---|---|---|
| OpenClaw | ✅ | `2026.10.9 (8b18b55)` |
| 私有 Node 运行时 | ✅ | `v24.22.1`（系统 Node 过旧，未改动全局） |
| GLM 模型 | ✅ | 实际调用 `zai/glm-5.3` 返回中文答复 |
| Gateway | ✅ | loopback、token 认证、LaunchAgent 常驻、被 kill 后 5s 自动拉起 |
| 飞书通道 | ✅ | WebSocket `connected, works`，收发双向验证 |
| 安全审计 | ✅ | `0 critical`，exec 实测不可用 |
| 手机端 | ✅ | iPhone 私聊实测收到回复 |

## 快速开始

```bash
# 1. 安装（官方本地前缀模式，不需要 sudo）
curl -fsSL https://openclaw.ai/install-cli.sh | bash -s -- --prefix "$HOME/.openclaw" --no-onboard
export PATH="$HOME/.openclaw/bin:$PATH"
openclaw --version

# 2. 初始化 + GLM（把 <YOUR_GLM_KEY> 换成你自己的）
openclaw onboard --non-interactive --accept-risk \
  --mode local --auth-choice zai-coding-cn --zai-api-key "<YOUR_GLM_KEY>" \
  --agent-name JARVIS --gateway-bind loopback \
  --install-daemon --daemon-runtime node \
  --skip-search --skip-skills --skip-hooks --skip-ui --skip-channels

# 3. 飞书通道（插件 + 凭据安全录入，见 docs/03-feishu.md）
openclaw plugins install @openclaw/feishu
bash scripts/secure-credential-input.sh

# 4. 验收
openclaw gateway status
openclaw channels status --probe
openclaw security audit
```

## 仓库结构

```text
agents/     JARVIS 人设：SOUL.md（职责与边界）、IDENTITY.md、USER.md（用户偏好）
config/     openclaw.template.json —— 已脱敏的最终配置模板
docs/       安装、模型、飞书、安全、排错、验收报告
scripts/    凭据安全录入脚本（不回显、不进历史记录）
```

## 关键设计取舍

- **不改动系统 Node**：要求 Node ≥ 24.16，本机是 24.13.1，因此用私有运行时，Claude Code 等既有工具完全不受影响。
- **凭据不进配置文件**：飞书 App Secret 以 SecretRef 形式指向加密 store，配置里只有引用名。
- **最小权限**：`messaging` 工具面 + 仅追加文件/记忆工具，文件访问锁定在 workspace，`exec` 与 Code Mode 关闭。
- **只认一个主人**：飞书私聊走 open_id 白名单，群聊整体禁用，不接收其他机器人消息。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/01-install.md](docs/01-install.md) | 安装与 Node 版本策略 |
| [docs/02-model-glm.md](docs/02-model-glm.md) | GLM / Z.AI 四种端点选择 |
| [docs/03-feishu.md](docs/03-feishu.md) | 飞书应用、WebSocket、访问控制 |
| [docs/04-security.md](docs/04-security.md) | 权限模型与审计结果 |
| [docs/05-troubleshooting.md](docs/05-troubleshooting.md) | 实际踩到的 6 个坑 |
| [docs/06-acceptance-report.md](docs/06-acceptance-report.md) | 完整验收记录 |

## 说明

本项目是**个人部署配置**，不是 OpenClaw 官方项目。OpenClaw 版权归其作者所有（MIT），详见 <https://github.com/openclaw/openclaw>。
