# 05 · 排错：实际踩到的坑

按发生顺序，全部是本次部署真实遇到的。

## 1. Node 版本过旧

**现象**：`openclaw` 装完跑不起来，或 npm 报 engine 不匹配。

**原因**：要求 Node 24.16.0+，本机 24.13.1。

**处理**：用官方 `install-cli.sh` 装私有 Node 24.22.1，不动系统 Node。

```bash
curl -fsSL https://openclaw.ai/install-cli.sh | bash -s -- --prefix "$HOME/.openclaw" --no-onboard
```

## 2. 飞书报 10014 app secret invalid

**现象**：

```text
feishu[default]: failed to get tenant_access_token, code: 10014, app secret invalid
```

**诊断**：绕开 OpenClaw，直接打飞书 API 判断是凭据问题还是配置问题：

```bash
curl -sS -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H "Content-Type: application/json" \
  -d '{"app_id":"cli_xxx","app_secret":"xxx"}'
```

仍然 10014 → 凭据本身有问题，不是 OpenClaw 的锅。

**真实原因**：App Secret 被粘贴了 3 遍（96 = 32×3）。取前 32 位后 `code: 0 ok`。

**教训**：先验证 32 位长度；`scripts/secure-credential-input.sh` 已内置重复粘贴检测。

## 3. `openclaw pairing list` 失败

**现象**：

```text
No chat DM pairing channels are configured.
```

飞书明明配了 `dmPolicy: pairing`，配对请求也确实产生了（日志里有 `pairing request sender=ou_xxx`），但 CLI 无法列出/审批。

**处理**：放弃 CLI 配对，改 `allowlist` + 从日志抓 open_id 写进白名单。更严格，也不依赖这个 bug 的修复。

## 4. 流式卡片 HTTP 400

**现象**：

```text
streaming start failed; using non-streaming card fallback for 60s: Create card request failed with HTTP 400
```

**原因**：应用缺卡片相关权限。消息仍然正常送达（自动降级）。

**处理**：`channels.feishu.streaming.mode off`。

## 5. 记忆索引指向 OpenAI 却没 Key

**现象**：`openclaw doctor` 提示 memory search provider 为 `openai` 但无 API Key，记忆不会入库。

**处理**：改用纯关键词检索，零额外 Key：

```bash
openclaw config set memory.search.provider none
openclaw memory index --force --agent jarvis
```

## 6. Code Mode 默认开启

**现象**：问 JARVIS「能否执行代码」，它说可以跑沙箱 JavaScript。

**原因**：`tools.codeMode` 未设置时默认 `auto`。

**处理**：`openclaw config set tools.codeMode false`，并用新 session 实测确认 `Unknown tool id: exec`。

## 7. 文档站抓正文被导航淹没

**现象**：`web_fetch` 抓到 docs 页面全是侧边栏，正文被截断。

**处理**：任何页面加 `.md` 后缀拿干净 Markdown：

```bash
curl -sL https://docs.openclaw.ai/channels/feishu/setup.md
```

目录索引：`https://docs.openclaw.ai/llms.txt`

## 8. PATH 没生效

安装器不写 shell 配置；且 `.zshrc` 只对交互式 shell 生效。

```bash
zsh -ic 'command -v openclaw'   # 这样才验证得到
```
