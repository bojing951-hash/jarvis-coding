# 02 · GLM 模型接入

## Provider

GLM 不是一个独立 provider，而是 `zai` provider 下的模型族，引用写法 `zai/glm-5.3`。

| 项 | 值 |
|---|---|
| Provider | `zai` |
| 插件 | `@openclaw/zai-provider` |
| 认证 | `ZAI_API_KEY` |
| 协议 | OpenAI Chat Completions（Bearer） |

## 四个端点（选错区域是最常见的失败原因）

| 初始化选项 | Base URL | 默认模型 |
|---|---|---|
| `zai-global` | `https://api.z.ai/api/paas/v4` | glm-5.2 |
| `zai-cn` | `https://open.bigmodel.cn/api/paas/v4` | glm-5.2 |
| `zai-coding-global` | `https://api.z.ai/api/coding/paas/v4` | glm-5.3 |
| `zai-coding-cn` | `https://open.bigmodel.cn/api/coding/paas/v4` | glm-5.3 |

`zai-api-key` 会用你的 Key 依次探测并自动选中，顺序是 general 优先于 coding。**如果 Key 两个都能用、你买的是 Coding Plan，必须显式指定**，否则可能落到普通 API 额度上。

## 本机实际选择

Claude Code 原来配的是：

```text
ANTHROPIC_BASE_URL = https://open.bigmodel.cn/api/anthropic
ANTHROPIC_MODEL    = glm-5.3
```

这是智谱的 **Anthropic 兼容** coding 端点。OpenClaw 走 OpenAI 协议，所以换成同区域的对应端点：

```text
zai-coding-cn → https://open.bigmodel.cn/api/coding/paas/v4
```

**同一个 Key 直接复用，没有覆盖 Claude Code 的任何配置**——两者读的是不同文件、不同变量。

## 非交互式初始化

```bash
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice zai-coding-cn \
  --zai-api-key "$GLM_KEY" \
  --agent-name JARVIS \
  --gateway-bind loopback \
  --install-daemon --daemon-runtime node \
  --skip-search --skip-skills --skip-hooks --skip-ui --skip-channels
```

`--accept-risk` 是非交互模式必需的显式风险确认，不是可选项。

## 验证

```bash
openclaw models list --all --provider zai
openclaw agent --agent jarvis --message "用一句话回答你是谁" --json
```

真实的调用证据在 `executionTrace` 里：

```json
{ "winnerProvider": "zai", "winnerModel": "glm-5.3", "attempts": [{"result": "success"}] }
```

## 限流

Coding Plan 是容量管理服务，高峰期（新加坡时间 14–18 点）可能返回 `429` 或错误码 `1302` / `1305`。属于正常波动，重试即可；非高峰期持续失败才是配置问题。
