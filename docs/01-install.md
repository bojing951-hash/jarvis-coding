# 01 · 安装与 Node 版本策略

## 环境基线（实测）

| 项 | 值 |
|---|---|
| 系统 | macOS 15.6.1 (24G90) |
| 芯片 | Apple M4 / arm64 |
| 系统 Node | v24.13.1（**不满足要求**） |
| npm | 11.8.0 |
| brew | 未安装 |

## 版本要求

OpenClaw 要求 **Node 24.16.0+（24.x）或 26.1.0+**，并建议 24.22.1+ / 26.12.1+（修复了 `node:sqlite` 的 NUL 截断问题）。

本机 24.13.1 低于下限，`npm install -g openclaw` 会装出无法运行的版本。

## 三种安装方式怎么选

| 方式 | 命令 | 适用 |
|---|---|---|
| 本地前缀（**本次采用**） | `install-cli.sh --prefix ~/.openclaw` | 想把 Node 和 CLI 关在自己目录里，不动系统 |
| 官方一键 | `install.sh` | 愿意让它接管/升级 Node |
| npm 全局 | `npm i -g openclaw@latest --allow-scripts=openclaw` | 你自己管理 Node 且版本已达标 |

选本地前缀的理由：**不改动全局 Node**，因此 Claude Code、nvm 默认版本、其他工具全部不受影响。

## 实际执行的命令

```bash
# 先下载审阅，不盲管道执行
curl -fsSL https://openclaw.ai/install-cli.sh -o /tmp/oc-install-cli.sh
shasum -a 256 /tmp/oc-install-cli.sh
# 4b02806b3bd59eba236e8cdcf2cef93ef0bcdf5324dfd5ecbd1aaa7b66ac8a97

/bin/bash /tmp/oc-install-cli.sh --prefix "$HOME/.openclaw" --no-onboard --json
```

安装结果：

```text
node 24.22.1 installed      → ~/.openclaw/tools/node-v24.22.1
openclaw latest installed   → ~/.openclaw/bin/openclaw
OpenClaw 2026.10.9 (8b18b55)
```

## 安装来源核验

- npm 包：`openclaw@2026.10.9`，MIT，仓库 `github.com/openclaw/openclaw`
- 维护者：`steipete`、`vincentkoc`
- 脚本经 TLS 直连 `openclaw.ai` 获取，执行前已本地审阅，未安装任何第三方插件

## PATH

安装器不会自动改 shell 配置，需自己加：

```bash
echo 'export PATH="$HOME/.openclaw/bin:$PATH"' >> ~/.zshrc   # 注意是 .zshrc，不是 .zprofile
```

`.zshrc` 只对交互式 shell 生效，`zsh -lc` 验证不到，属正常。

## 验证

```bash
openclaw --version      # OpenClaw 2026.10.9 (8b18b55)
openclaw doctor
```
