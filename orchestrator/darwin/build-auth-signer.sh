#!/bin/sh
# 构建/安装 JARVIS Secure Enclave 审批签名器。
# 用法：orchestrator/darwin/build-auth-signer.sh [输出路径]
# 默认安装到 ~/.openclaw/jarvis/bin/jarvis-auth
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
OUT=${1:-"$HOME/.openclaw/jarvis/bin/jarvis-auth"}
mkdir -p "$(dirname -- "$OUT")"
swiftc -O "$DIR/approval-signer.swift" -o "$OUT"
chmod 0755 "$OUT"
echo "built: $OUT"
