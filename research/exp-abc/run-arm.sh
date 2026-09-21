#!/usr/bin/env bash
# Executa um braço do experimento A/B/C sobre o snapshot congelado.
#
#   ./run-arm.sh <a|b|c> <rep>
#
# a — review explícito standalone (usuário pede, sem hook)
# b — jev-enhancer completo (hook -> prepare -> subagente -> Jev verify)
# c — minimal trigger (hook -> mesma instrução do braço A, nada mais)
#
# Entre execuções o repo volta ao snapshot, então os três braços revisam
# exatamente o mesmo código. As permissões vêm de perms.json: allowlist
# somente-leitura, com escrita liberada apenas no arquivo de achados.
set -euo pipefail

ARM="${1:?uso: run-arm.sh <a|b|c> <rep>}"
REP="${2:?uso: run-arm.sh <a|b|c> <rep>}"

EXP="$(cd "$(dirname "$0")" && pwd)"
REPO=/Users/cesc/Projects/pdv-feat-baseline
JEV=/Users/cesc/Projects/jev-enhancer
OUT="$EXP/runs/$ARM-$REP"
MODEL=claude-opus-5

# credencial na variável certa + ambiente limpo da sessão pai
# shellcheck disable=SC1091
. "$EXP/env.sh"
TRIVIAL='Responda em UMA linha, sem preambulo: quantos arquivos .go existem em packages/api-go/internal/fiado/?'

mkdir -p "$OUT"

# ---------- restaura o snapshot ----------
cd "$REPO"
git checkout -- packages/api-go/cmd/server/main.go \
                packages/api-go/internal/middleware/apikey_test.go \
                packages/api-go/internal/middleware/routes.go 2>/dev/null || true
rm -rf packages/api-go/internal/fiado \
       packages/api-go/internal/handler/fiado.go \
       packages/api-go/internal/handler/fiado_router.go \
       packages/api-go/internal/handler/fiado_router_test.go \
       packages/api-go/internal/db/fiado_integration_test.go \
       packages/api-go/query/fiado.sql \
       .claude .jev .jev-exp
tar xzf "$EXP/snapshot.tar.gz" -C "$REPO"
mkdir -p "$REPO/.claude"

# ---------- configura o braço ----------
case "$ARM" in
  a)
    HOOKS='{}'
    PROMPT="$(cat "$EXP/prompts/review-instruction.md")"
    ;;
  b)
    HOOKS="{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/stop-hook.mjs\",\"timeout\":60}]}]}"
    mkdir -p "$REPO/.jev"
    cp "$EXP/jev-config.yaml" "$REPO/.jev/config.yaml"
    PROMPT="$TRIVIAL"
    ;;
  c)
    HOOKS="{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $EXP/hooks/minimal-stop-hook.mjs\",\"timeout\":60}]}]}"
    PROMPT="$TRIVIAL"
    ;;
  *) echo "braço inválido: $ARM" >&2; exit 1 ;;
esac

python3 - "$EXP/perms.json" "$REPO/.claude/settings.json" "$HOOKS" <<'PY'
import json, sys
base = json.load(open(sys.argv[1]))
base.pop("_comment", None)
hooks = json.loads(sys.argv[3])
if hooks:
    base["hooks"] = hooks
json.dump(base, open(sys.argv[2], "w"), indent=1)
PY

# ---------- executa ----------
echo "[$ARM-$REP] iniciando..." >&2
START=$(date +%s)
set +e
claude -p "$PROMPT" --model "$MODEL" --output-format json < /dev/null \
  > "$OUT/result.json" 2> "$OUT/stderr.log"
STATUS=$?
set -e
END=$(date +%s)
echo "$((END-START))" > "$OUT/seconds.txt"
echo "$STATUS" > "$OUT/exit.txt"

# ---------- coleta ----------
rm -f "$OUT/findings.json"
for f in "$REPO/.jev-exp/findings.json" "$REPO/.jev/findings.json" "$REPO/.jev/fiado-findings.json"; do
  if [ -f "$f" ]; then cp "$f" "$OUT/findings.json"; break; fi
done
[ -d "$REPO/.jev" ] && cp -R "$REPO/.jev" "$OUT/jev-dir" 2>/dev/null
[ -d "$REPO/.jev-exp" ] && cp -R "$REPO/.jev-exp" "$OUT/jev-exp-dir" 2>/dev/null

echo "[$ARM-$REP] exit=$STATUS em $((END-START))s" >&2
exit 0
