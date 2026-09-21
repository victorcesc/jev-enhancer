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
ROOT="$(cd "$EXP/../.." && pwd)"

# A chave pode vir do ambiente ou de um .env gitignorado — assim ela nunca
# precisa ser digitada numa linha de comando que fica no histórico.
if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  cat >&2 <<EOF
ANTHROPIC_API_KEY não está definida — toda execução falharia em ~2s com
"Not logged in". Coloque a chave em $ROOT/.env (já está no .gitignore):

    ANTHROPIC_API_KEY=sk-ant-...

e rode de novo.
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
