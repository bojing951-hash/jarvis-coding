# 03 · 飞书通道

## 前置：飞书开放平台

在 <https://open.feishu.cn> 的企业自建应用里需要具备：

| 项 | 要求 |
|---|---|
| 应用类型 | 企业自建应用（自建应用才支持长连接） |
| 机器人 | 已启用 |
| 权限 | `im:message`、`im:message:send_as_bot` |
| 事件订阅 | `im.message.receive_v1`，**订阅方式选「使用长连接接收事件」** |
| 版本 | 已发布（改权限后必须重新发布版本才生效） |

不需要 `contact:*` 权限——它只影响「显示发送者姓名」，聊天本身不依赖它。

## 插件

```bash
openclaw plugins install @openclaw/feishu
```

## 配置（非交互式）

飞书的 `channels add` 没有 `--app-id/--app-secret` 参数，只能走配置键：

```bash
openclaw config set channels.feishu.enabled true --strict-json
openclaw config set channels.feishu.domain feishu
openclaw config set channels.feishu.connectionMode websocket
openclaw config set channels.feishu.accounts.default.appId "cli_xxxxxxxxxxxxxxxx"
openclaw config set channels.feishu.dmPolicy allowlist
openclaw config set channels.feishu.allowFrom '["ou_你的open_id"]' --strict-json
openclaw config set channels.feishu.groupPolicy disabled
openclaw config set channels.feishu.allowBots false --strict-json
openclaw config set commands.ownerAllowFrom '["feishu:ou_你的open_id"]' --strict-json
```

## App Secret 走 SecretRef，不落明文

```bash
bash scripts/secure-credential-input.sh
openclaw secrets store import --from ~/.openclaw/.private/feishu.env --kind secret --yes
openclaw config set channels.feishu.accounts.default.appSecret \
  --ref-provider default --ref-source store --ref-id FEISHU_APP_SECRET
rm -P ~/.openclaw/.private/feishu.env
openclaw secrets reload
```

配置文件里最终只有：

```json
"appSecret": { "source": "store", "provider": "default", "id": "FEISHU_APP_SECRET" }
```

## 拿到自己的 open_id

先临时把 `dmPolicy` 设为 `pairing`，用手机发一条消息，然后在日志里找：

```bash
grep "received message from" ~/Library/Logs/openclaw/gateway.log | tail -3
# feishu[default]: received message from ou_xxxx in oc_xxxx (p2p)
```

拿到后改回 `allowlist` 并写入 `allowFrom`。

> 本版本 `openclaw pairing list` 会报 `No chat DM pairing channels are configured`，无法用 CLI 审批配对。直接改用 allowlist 更确定，也更严格。

## 访问控制语义

| dmPolicy | 行为 |
|---|---|
| `pairing` | 陌生人收到配对码，需 CLI 审批（本版本 CLI 不可用） |
| `allowlist` | **只有 allowFrom 里的人能私聊**（推荐） |
| `open` | 任何人可私聊，需 `allowFrom` 含 `"*"` |
| `disabled` | 关闭私聊 |

`groupPolicy: disabled` 高于一切：即使写了 `groups.<chat_id>` 也不放行群聊。

## 只保留聊天工具

飞书插件默认还带文档/云盘/权限/多维表格等工具，与 MVP 无关，全部关掉：

```bash
for t in doc wiki drive perm bitable scopes; do
  openclaw config set "channels.feishu.tools.$t" false --strict-json
done
```

`doc` 的风险点：`feishu_doc create` 会把文档权限授予发起人，属于意外提权面。

## 验证

```bash
openclaw channels status --probe
# - Feishu default (JARVIS): enabled, configured, running, connected, works
```

## 流式卡片

若日志出现 `Create card request failed with HTTP 400`，说明缺少卡片权限。关闭流式即可，回复不受影响：

```bash
openclaw config set channels.feishu.streaming.mode off
```
