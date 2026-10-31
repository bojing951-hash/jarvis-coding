#!/bin/bash
# 凭据安全录入：App Secret 不回显、不进 shell 历史、落盘权限 600。
# 用法：bash scripts/secure-credential-input.sh
set -euo pipefail

DIR="${OPENCLAW_HOME:-$HOME/.openclaw}/.private"
OUT="$DIR/feishu.env"
mkdir -p "$DIR"
chmod 700 "$DIR"
umask 077

printf '%s\n' "--------------------------------------------------"
printf '%s\n' " 飞书凭据安全录入"
printf '%s\n' " App ID 会显示；App Secret 输入时不回显。"
printf '%s\n' "--------------------------------------------------"

printf 'App ID (形如 cli_xxxxxxxxxxxx): '
read -r APP_ID
printf 'App Secret (输入后回车，不显示): '
read -rs APP_SECRET
printf '\n'

if [ -z "${APP_ID:-}" ] || [ -z "${APP_SECRET:-}" ]; then
  printf '%s\n' "输入为空，已取消，未写入任何内容。"
  exit 1
fi

# 常见错误：把 App Secret 重复粘贴多次（飞书会报 10014 app secret invalid）
LEN=${#APP_SECRET}
if [ "$LEN" -gt 40 ]; then
  FIRST32="${APP_SECRET:0:32}"
  if [ "${APP_SECRET:32:32}" = "$FIRST32" ] || [ "${APP_SECRET:0:32}" != "${APP_SECRET:32:64}" ]; then
    printf '%s\n' "警告：App Secret 长度为 $LEN，飞书通常为 32 位，疑似重复粘贴。"
    printf '%s\n' "已按前 32 位写入；如仍报 10014 请重新运行本脚本。"
    APP_SECRET="$FIRST32"
  fi
fi

printf 'FEISHU_APP_ID=%s\nFEISHU_APP_SECRET=%s\n' "$APP_ID" "$APP_SECRET" > "$OUT"
chmod 600 "$OUT"

printf '%s\n' "已写入 $OUT （权限 600）。导入后请立即删除该文件："
printf '%s\n' "  openclaw secrets store import --from $OUT --kind secret --yes"
printf '%s\n' "  rm -P $OUT"
