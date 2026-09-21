#!/usr/bin/env bash
# Matriz do Experimento D: d1/d2/d3 × N repetições.
#
#   ./run-all.sh [reps]
#
# Sequencial: o harness restaura o snapshot antes de cada execução, então
# duas sessões simultâneas no mesmo repo se atropelam.
set -euo pipefail

REPS="${1:-3}"
EXP="$(cd "$(dirname "$0")" && pwd)"

for rep in $(seq 1 "$REPS"); do
  for arm in d1 d2 d3; do
    if [ -f "$EXP/runs/$arm-$rep/findings.json" ]; then
      echo "[$arm-$rep] já existe, pulando" >&2
      continue
    fi
    "$EXP/run-arm.sh" "$arm" "$rep" || echo "[$arm-$rep] FALHOU (segue)" >&2
  done
done

echo
JEV_RUNS="$EXP/runs" python3 "$EXP/../exp-abc/score.py" --summary
