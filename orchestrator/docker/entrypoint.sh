#!/bin/sh
# 固定入口：凭据由只读文件挂载提供，不通过 docker run -e 传入，
# 以免密钥出现在 `docker inspect` 的 Env 里。
set -eu

if [ -f /run/secrets/glm.env ]; then
  # shellcheck disable=SC1091
  set -a
  . /run/secrets/glm.env
  set +a
  rm -f /run/secrets/glm.env 2>/dev/null || true
fi

exec claude "$@"
