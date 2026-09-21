#!/usr/bin/env bash
# Experimento F — o decision space substitui descoberta aberta?
#
#   ./run-arm.sh <f0|f1> <rep>
#
# f0 — baseline: review aberta ("ache o que estiver errado")
# f1 — decision space -> LLM. O mapa entra como PISTAS, e o protocolo diz
#      explicitamente que a LLM continua livre para achar fora dele.
#
# O Jev NÃO está no caminho decisório de nenhum dos dois (ver
# docs/DECISAO-JEV-OBSERVADOR.md). Única variável: a LLM recebe ou não o mapa.
set -euo pipefail

ARM="${1:?uso: run-arm.sh <f0|f1> <rep>}"
REP="${2:?uso: run-arm.sh <f0|f1> <rep>}"

EXP="$(cd "$(dirname "$0")" && pwd)"
ABC="$EXP/../exp-abc"
REPO=/Users/cesc/Projects/pdv-feat-baseline
JEV="$(cd "$EXP/../.." && pwd)"
OUT="$EXP/runs/$ARM-$REP"
MODEL=claude-opus-5

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
       .claude .jev .jev-exp .findings.json
tar xzf "$ABC/snapshot.tar.gz" -C "$REPO"
mkdir -p "$REPO/.claude" "$REPO/.jev"
cp "$EXP/jev-config-$ARM.yaml" "$REPO/.jev/config.yaml"

HOOKS="{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/session-start-hook.mjs\",\"timeout\":15}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/stop-hook.mjs\",\"timeout\":60}]}]}"

python3 - "$ABC/perms.json" "$REPO/.claude/settings.json" "$HOOKS" <<'PY'
import json, sys
base = json.load(open(sys.argv[1])); base.pop("_comment", None)
base["hooks"] = json.loads(sys.argv[3])
json.dump(base, open(sys.argv[2], "w"), indent=1)
PY

# ---------- executa ----------
echo "[$ARM-$REP] iniciando..." >&2
START=$(date +%s)
set +e
claude -p "$FINALIZAR" --model "$MODEL" --output-format json < /dev/null \
  > "$OUT/result.json" 2> "$OUT/stderr.log"
STATUS=$?
set -e
echo "$(( $(date +%s) - START ))" > "$OUT/seconds.txt"

# ---------- coleta ----------
rm -f "$OUT/findings.json"
for f in "$REPO/.jev/findings.json" "$REPO"/.jev/*findings*.json "$REPO/.findings.json"; do
  if [ -f "$f" ]; then cp "$f" "$OUT/findings.json"; break; fi
done
[ -d "$REPO/.jev" ] && cp -R "$REPO/.jev" "$OUT/jev-dir" 2>/dev/null

# Proporção candidato vs independente — é o que responde se o mapa
# ANTECIPA descoberta sem matar serendipidade.
python3 - "$OUT" <<'PY'
import json, os, sys
out = sys.argv[1]
info = {"total": 0, "from_map": 0, "independent": 0, "sem_campo": 0}
try:
    doc = json.load(open(os.path.join(out, "findings.json")))
    for f in (doc.get("findings") if isinstance(doc, dict) else doc) or []:
        info["total"] += 1
        if "from_candidate" not in f:
            info["sem_campo"] += 1
        elif f.get("from_candidate"):
            info["from_map"] += 1
        else:
            info["independent"] += 1
except Exception:
    pass
json.dump(info, open(os.path.join(out, "origem.json"), "w"), indent=1)
print("  achados: {total} | do mapa: {from_map} | independentes: {independent}".format(**info))
PY

echo "[$ARM-$REP] exit=$STATUS em $(cat "$OUT/seconds.txt")s" >&2
exit 0
