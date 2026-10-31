# JARVIS 执行器镜像（P0-SEC-01-FIX1）
#
# 刻意保持最小：
# - 只有 node + git + claude CLI
# - 非 root 用户（uid 1000）
# - 不含任何凭据；ANTHROPIC_* 只在运行时注入
# - 工作目录固定 /work（由编排层只挂载授权副本）
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DISABLE_AUTOUPDATER=1 \
    DISABLE_TELEMETRY=1 \
    DISABLE_ERROR_REPORTING=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# 版本固定，避免构建漂移
ARG CLAUDE_CODE_VERSION=2.1.104
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && npm cache clean --force

# 非特权用户：直接复用 node 镜像内置的 node 用户（uid 1000）
RUN mkdir -p /work && chown -R node:node /work

COPY --chown=root:root orchestrator/docker/entrypoint.sh /usr/local/bin/jarvis-entrypoint.sh
RUN chmod 0555 /usr/local/bin/jarvis-entrypoint.sh

USER node
WORKDIR /work

# 入口负责加载只读挂载的凭据文件，再 exec claude
ENTRYPOINT ["/usr/local/bin/jarvis-entrypoint.sh"]
CMD ["--version"]
