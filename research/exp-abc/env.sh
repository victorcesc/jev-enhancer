#!/usr/bin/env bash
# Prepara o ambiente para disparar uma sessão `claude` headless.
#
# Dois problemas reais que isto resolve:
#
# 1. Credencial na variável certa. Um token que começa com `sk-ant-oat` é
#    OAuth e vai em CLAUDE_CODE_OAUTH_TOKEN; em ANTHROPIC_API_KEY ele é
#    aceito, tentado, e só depois de ~4 min de retry devolve
#    `401 API key is invalid` — parece travamento, não erro de config.
#
# 2. Herança da sessão pai. Um `claude` disparado de dentro de outro herda
#    CLAUDE_CODE_MESSAGING_SOCKET, CLAUDE_CODE_SESSION_ID, CHILD_SESSION e
#    afins. Limpar tudo antes garante que cada execução do experimento é uma
#    sessão isolada e comparável.
#
# Uso: `. env.sh` (precisa de JEV definido)

for _v in $(printenv | grep -o "^CLAUDE[A-Z_]*=" | tr -d '='); do unset "$_v"; done
unset _v

if [ -f "$JEV/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$JEV/.env"
  set +a
fi

_CRED="${CLAUDE_CODE_OAUTH_TOKEN:-${ANTHROPIC_API_KEY:-}}"
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN

if [ -z "$_CRED" ]; then
  echo "Nenhuma credencial encontrada (nem no ambiente, nem em $JEV/.env)." >&2
  return 1 2>/dev/null || exit 1
fi

case "$_CRED" in
  sk-ant-oat*) export CLAUDE_CODE_OAUTH_TOKEN="$_CRED" ;;
  *)           export ANTHROPIC_API_KEY="$_CRED" ;;
esac
unset _CRED
