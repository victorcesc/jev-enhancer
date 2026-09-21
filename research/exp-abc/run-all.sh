#!/usr/bin/env bash
# Matriz completa A/B/C x N repetições sobre o snapshot congelado.
#
#   ANTHROPIC_API_KEY=... ./run-all.sh [reps]
#
# Sequencial de propósito: duas sessões `claude` no mesmo repo se atropelam,
# porque o harness restaura o snapshot antes de cada execução.
set -euo pipefail

REPS="${1:-3}"
EXP="$(cd "$(dirname "$0")" && pwd)"
JEV="$(cd "$EXP/../.." && pwd)"
export JEV

# shellcheck disable=SC1091
if ! . "$EXP/env.sh"; then
  cat >&2 <<EOF
Sem credencial. Coloque em $JEV/.env (já está no .gitignore):

    ANTHROPIC_API_KEY=sk-ant-api03-...     # chave de API
    CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-... # ou token OAuth

O env.sh roteia pelo prefixo, então qualquer um dos dois nomes serve.
EOF
  exit 1
fi

for rep in $(seq 1 "$REPS"); do
  for arm in a b c; do
    if [ -f "$EXP/runs/$arm-$rep/findings.json" ]; then
      echo "[$arm-$rep] já existe, pulando" >&2
      continue
    fi
    "$EXP/run-arm.sh" "$arm" "$rep" || echo "[$arm-$rep] FALHOU (segue)" >&2
  done
done

echo
python3 "$EXP/score.py" --matrix
