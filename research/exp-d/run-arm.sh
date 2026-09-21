#!/usr/bin/env bash
# Experimento D — o enquadramento do review afeta o recall?
#
#   ./run-arm.sh <d1|d2|d3> <rep>
#
# d1 — usuário pede o review no prompt (referência externa; = braço A do ABC)
# d2 — B-stop: pipeline disparado pelo Stop hook, com a instrução completa
#      no bloqueio. É a arquitetura ANTIGA, preservada em hooks/.
# d3 — B-pre: pipeline idêntico, mas o review entra como Definition of Done
#      no início da sessão. Stop é só fallback.
#
# VARIÁVEL ÚNICA: como e quando o review é introduzido. Pipeline interno,
# prepared context, prompt do worker, nº de workers, modelo, snapshot e
# config do Jev são idênticos nos três.
set -euo pipefail

ARM="${1:?uso: run-arm.sh <d1|d2|d3> <rep>}"
REP="${2:?uso: run-arm.sh <d1|d2|d3> <rep>}"

EXP="$(cd "$(dirname "$0")" && pwd)"
ABC="$EXP/../exp-abc"
REPO=/Users/cesc/Projects/pdv-feat-baseline
JEV="$(cd "$EXP/../.." && pwd)"
OUT="$EXP/runs/$ARM-$REP"
MODEL=claude-opus-5

# Prompt dos braços com gatilho automático. Deliberadamente NÃO menciona
# review: se mencionasse, d2 e d3 estariam ambos sendo "pedidos", e a
# variável em teste desapareceria.
FINALIZAR='As mudancas nao commitadas neste repositorio sao a implementacao da feature GET /api/v1/customers/{id}/fiado, que acabei de concluir. De a tarefa por finalizada.'

# shellcheck disable=SC1091
. "$ABC/env.sh"

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
tar xzf "$ABC/snapshot.tar.gz" -C "$REPO"
mkdir -p "$REPO/.claude" "$REPO/.jev"
cp "$ABC/jev-config.yaml" "$REPO/.jev/config.yaml"

# ---------- configura o braço ----------
case "$ARM" in
  d1)
    HOOKS='{}'
    PROMPT="$(cat "$ABC/prompts/review-instruction.md")"
    ;;
  d2)
    HOOKS="{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $EXP/hooks/stop-hook-legacy.mjs\",\"timeout\":60}]}]}"
    PROMPT="$FINALIZAR"
    ;;
  d3)
    HOOKS="{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/session-start-hook.mjs\",\"timeout\":15}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/stop-hook.mjs\",\"timeout\":60}]}]}"
    PROMPT="$FINALIZAR"
    ;;
  *) echo "braço inválido: $ARM" >&2; exit 1 ;;
esac

python3 - "$ABC/perms.json" "$REPO/.claude/settings.json" "$HOOKS" <<'PY'
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
# O subagente nem sempre usa o nome canônico (d2-2 gravou fiado_findings.json
# quando a triagem falhou). Qualquer arquivo de achados serve para pontuar.
rm -f "$OUT/findings.json"
for f in "$REPO/.jev-exp/findings.json" "$REPO/.jev/findings.json" \
         "$REPO"/.jev/*findings*.json "$REPO"/.jev-exp/*findings*.json; do
  if [ -f "$f" ]; then cp "$f" "$OUT/findings.json"; break; fi
done
[ -d "$REPO/.jev" ] && cp -R "$REPO/.jev" "$OUT/jev-dir" 2>/dev/null
[ -d "$REPO/.jev-exp" ] && cp -R "$REPO/.jev-exp" "$OUT/jev-exp-dir" 2>/dev/null

# Quem disparou o review: é a métrica que distingue d2 de d3 quando o
# agente esquece e cai no fallback.
python3 - "$OUT" "$REPO" <<'PY'
import json, os, sys
out, repo = sys.argv[1], sys.argv[2]
info = {"stop_blocks": 0, "trigger": "desconhecido", "verificou": False}
try:
    for line in open(os.path.join(repo, ".jev", "runs.jsonl")):
        d = json.loads(line)
        stage, status = d.get("stage"), d.get("status")
        # O hook LEGADO (d2) grava sem `stage`; o fallback novo grava
        # stage="fallback". Os dois contam como bloqueio do Stop.
        if status == "completed" and stage in (None, "fallback"):
            info["stop_blocks"] += 1
        if stage == "review" and d.get("trigger") == "agent":
            info["trigger"] = "agente (Definition of Done)"
        if stage == "verify":
            info["verificou"] = True
    if info["stop_blocks"] and info["trigger"] == "desconhecido":
        info["trigger"] = "Stop hook"
except FileNotFoundError:
    pass
json.dump(info, open(os.path.join(out, "trigger.json"), "w"), indent=1)
print("  trigger: {trigger} | stop_blocks: {stop_blocks} | verificou: {verificou}".format(**info))
PY

echo "[$ARM-$REP] exit=$STATUS em $((END-START))s" >&2
exit 0
