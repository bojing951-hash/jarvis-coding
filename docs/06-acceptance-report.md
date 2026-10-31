# 06 · 验收报告

日期：2026-10-31 · 环境：macOS 15.6.1 / Apple M4 / arm64

## 验收结论

**JARVIS MVP v0.1 达到基本运行标准**，手机端实测通过。

| 验收项目 | 状态 | 实际证据 |
|---|---|---|
| OpenClaw 安装 | PASS | `OpenClaw 2026.10.9 (8b18b55)` |
| 私有 Node 运行时 | PASS | `v24.22.1`，未改动系统 Node |
| GLM 模型 | PASS | 真实调用 `zai/glm-5.3`，多次返回中文答复 |
| Gateway | PASS | `127.0.0.1:18789` loopback + token；LaunchAgent 常驻；kill -9 后 5s 自动恢复 |
| 飞书连接 | PASS | `channels status --probe` = `connected, works` |
| JARVIS 角色 | PASS | `workspace/SOUL.md`、`IDENTITY.md`、`USER.md` |
| 安全权限 | PASS | `security audit` = 0 critical；新 session 实测 `Unknown tool id: exec` |
| 手机端测试 | PASS | iPhone 私聊收到回复；出站消息 ID `om_x100b616ebf9444a8df28dd7dea47925` |

## 关键运行参数

```text
Gateway   bind=loopback  127.0.0.1:18789  auth=token  tailscale=off
Agent     jarvis (JARVIS)  model=zai/glm-5.3
Channel   feishu  connectionMode=websocket  dmPolicy=allowlist  groupPolicy=disabled
Tools     profile=messaging +group:fs +group:memory  fs.workspaceOnly=true
          exec.mode=deny  codeMode=false
```

## 端到端链路证据

| 时间 | 事件 |
|---|---|
| 17:01:01 | 收到私聊：`received message from ou_0ec1... (p2p)` |
| 17:01:01 | 生成配对请求（后续改用 allowlist） |
| 17:03:03 | 白名单放行：`DM from ou_0ec1...` → `dispatching to agent (session=agent:jarvis:main)` |
| 17:03:15 | `dispatch complete (queuedFinal=true, replies=1)` |
| 17:04:21 | CLI 出站成功：`om_x100b616ebf9444a8df28dd7dea47925` |
| 17:06 | 记忆落盘：`memory/2026-10-31.md` 由 agent 自行写入 |

## 记忆验证

agent 通过 workspace 内文件工具，自行创建了当日记忆文件：

```markdown
# 2026-10-31

## 测试记录
- 17:06 OPENCLAW-MVP-E2E-OK（端到端链路测试通过）
```

## 未完成 / 待人工确认

| 项 | 说明 |
|---|---|
| 飞书「显示发送者姓名」 | 缺 `contact:contact.base:readonly`，按「不申请无关权限」要求**刻意未申请**，不影响聊天 |
| 流式回复 | 缺卡片权限，已关闭流式；如需可后续补权限开启 |
| 插件版本锁定 | 审计提示未锁版本，可后续用 `@openclaw/feishu@<版本>` 固定 |
| 36 个内置技能 | 依赖未安装的外部二进制，未启用，不影响 MVP |

## 未做的事（按约定）

未安装其他 Agent、未连接邮箱、未授权任何正式 GitHub 仓库、未执行软件开发任务。
