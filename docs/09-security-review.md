# 09 · 安全审查（P1 增量）

在 MVP v0.1 基线之上，本次新增了「动态建 Agent」「跨 Agent 交接」「外部执行器」三类能力，
每一类都扩大了攻击面，逐项审查如下。

## 1. 新增的攻击面

| 新能力 | 风险 | 处置 |
|---|---|---|
| 动态创建 Agent | 每个 Agent 都是新的执行主体 | 全部继承受限 tool profile，无 Shell |
| provider 级凭据 | 一个 Key 被所有 Agent 使用 | SecretRef 指向加密 store，配置无明文 |
| MCP 控制面（22 工具） | 工具可建项目/任务/执行 | 只操作状态与调度，不直接读写任意文件 |
| Claude Code 执行器 | 最危险：能改代码 | 独立进程 + cwd 白名单 + 默认只读 + 写模式双重审批 |
| 工作流自动执行 | 可能失控循环 | `maxRounds` + `max_attempts` + 审批门 |

## 2. 主 Agent 权限面（未放宽）

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

JARVIS 通过 **MCP 工具**调度，而不是拿到 Shell。
实测：新 session 调用 exec → `Unknown tool id: exec`。

## 3. 外部执行器边界

```js
// executor.mjs
if (!['plan', 'acceptEdits'].includes(mode)) return error;
// 不传 --add-dir；不使用 bypassPermissions
if (mode === 'acceptEdits' && cfg.approved !== true) return blocked;
```

| 措施 | 状态 |
|---|---|
| 只在指定 `cwd` 执行 | 已验证（git HEAD 未变，只读） |
| 默认 `plan` | 已验证 |
| 写模式需 `approved=true` + 任务已批准 | 代码实现，**未在真实仓库演练** |
| 不访问全部 GitHub 仓库 | 执行器无 git push 凭据配置 |
| 不自动合并主分支 | 未授予任何 merge 能力 |
| 不读取/输出 API Key | 执行器进程不继承 OpenClaw 密钥环境 |

## 4. 凭据处理

| 项 | 状态 |
|---|---|
| GLM Key 存储 | secrets store（`ZAI_API_KEY`，secret 类型，write-only） |
| 配置引用方式 | `{ source: "store", provider: "default", id: "ZAI_API_KEY" }` |
| 飞书 App Secret | 同上（`FEISHU_APP_SECRET`） |
| 仓库中是否含密钥 | 否，提交前扫描过真实值 |
| Token 临时文件 | 用完立即删除（`rm -P`） |

`openclaw secrets audit` 仍报告 2 处明文：
`gateway.auth.token`（openclaw.json）与 zai key（agent sqlite）。
两者文件权限均为 `0600`，且本机专用。

## 5. 数据隔离

| 边界 | 实现 |
|---|---|
| 项目 ↔ 项目 | 独立目录 `projects/<slug>`，Agent 归属校验 |
| 会话 ↔ 会话 | OpenClaw session key 隔离 |
| 项目内跨 Agent | 交接只传显式字段，不复制历史 |
| 审计上下文 | 独立 Agent + 独立 session（未接代码审计流程） |

## 6. 审计结果

```text
openclaw security audit → 0 critical · 2 warn · 1 info
```

warn 1：`gateway.trusted_proxies_missing` —— loopback 无代理，不适用。
warn 2：`plugins.installs_unpinned_npm_specs` —— 插件版本未锁，可后续固定。

## 7. 已知风险（需人工决定是否收紧）

1. **MCP 工具无安全标注**：OpenClaw 提示 `calls require approval in prompting session postures`。
   飞书会话当前不触发交互审批，等于这些工具可被 Agent 直接调用。
   影响可控（工具只动调度状态），但如果要更严，可给工具加 annotation 或改审批模式。
2. **执行器写模式未实测**：`acceptEdits` 路径只有代码与审批门，没有真实仓库演练证据。
3. **审计 Agent 未隔离到只读代码视图**：P1-06 后半段（读固定 commit 审计）尚未实现。

## 8. 结论

未发现 critical 问题。
新增能力都有明确权限边界；最危险的外部执行器保持在「默认只读 + 审批后写入」。
**不建议**在没有演练的情况下放开执行器写模式到主项目目录。
