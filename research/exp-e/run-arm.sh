#!/usr/bin/env bash
# Experimento E — o Jev sustenta a qualidade num modelo barato?
#
#   ./run-arm.sh <rep> [modelo]
#
# Arquitetura D3 (Definition of Done) em TODAS as execuções. Variável única:
# o modelo. Padrão: Haiku 4.5, ~10x mais barato que Opus 5.
#
# Por que só um braço novo:
#   `findings.json` é o BRUTO, gravado antes da triagem. `findings-verified`
#   é o depois. Uma execução entrega os dois, então de cada run sai tanto o
#   recall "sem Jev" quanto o efeito do Jev — não precisa de braço separado.
#
#   E o baseline "Opus sem Jev" já existe: é o bruto das execuções d3-* do
#   experimento D. Zero execução nova para o controle.
#
# LIMITE ESTRUTURAL, registrado antes de medir: o Jev só CLASSIFICA
# (verifyFindings é um findings.map, nunca adiciona). Ele pode elevar
# precisão; não pode elevar recall. Se o Haiku não achar, nada recupera.
set -euo pipefail

REP="${1:?uso: run-arm.sh <rep> [modelo]}"
MODEL="${2:-claude-haiku-4-5-20251001}"

EXP="$(cd "$(dirname "$0")" && pwd)"
ABC="$EXP/../exp-abc"
REPO=/Users/cesc/Projects/pdv-feat-baseline
JEV="$(cd "$EXP/../.." && pwd)"
ARM="$(echo "$MODEL" | sed 's/claude-//; s/-[0-9]\{8\}$//; s/[.-]//g')"
OUT="$EXP/runs/$ARM-$REP"

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

HOOKS="{\"SessionStart\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/session-start-hook.mjs\",\"timeout\":15}]}],\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node $JEV/adapters/claude/stop-hook.mjs\",\"timeout\":60}]}]}"

python3 - "$ABC/perms.json" "$REPO/.claude/settings.json" "$HOOKS" <<'PY'
import json, sys
base = json.load(open(sys.argv[1]))
base.pop("_comment", None)
base["hooks"] = json.loads(sys.argv[3])
json.dump(base, open(sys.argv[2], "w"), indent=1)
PY

# ---------- executa ----------
echo "[$ARM-$REP] iniciando ($MODEL)..." >&2
START=$(date +%s)
set +e
claude -p "$FINALIZAR" --model "$MODEL" --output-format json < /dev/null \
  > "$OUT/result.json" 2> "$OUT/stderr.log"
STATUS=$?
set -e
END=$(date +%s)
echo "$((END-START))" > "$OUT/seconds.txt"
echo "$MODEL" > "$OUT/model.txt"

# ---------- coleta ----------
rm -f "$OUT/findings.json"
for f in "$REPO/.jev/findings.json" "$REPO"/.jev/*findings*.json "$REPO/.jev-exp/findings.json"; do
  if [ -f "$f" ]; then cp "$f" "$OUT/findings.json"; break; fi
done
[ -d "$REPO/.jev" ] && cp -R "$REPO/.jev" "$OUT/jev-dir" 2>/dev/null

python3 - "$OUT" "$REPO" <<'PY'
import json, os, sys
out, repo = sys.argv[1], sys.argv[2]
info = {"stop_blocks": 0, "trigger": "desconhecido", "verificou": False}
try:
    for line in open(os.path.join(repo, ".jev", "runs.jsonl")):
        d = json.loads(line)
        stage, status = d.get("stage"), d.get("status")
        if status == "completed" and stage in (None, "fallback"):
            info["stop_blocks"] += 1
        if stage == "review" and d.get("trigger") == "agent":
            info["trigger"] = "agente (Definition of Done)"
        if stage == "verify":
            info["verificou"] = True
    if info["stop_blocks"] and info["trigger"] == "desconhecido":
        info["trigger"] = "Stop hook (fallback)"
except FileNotFoundError:
    pass
json.dump(info, open(os.path.join(out, "trigger.json"), "w"), indent=1)
print("  trigger: {trigger} | stop_blocks: {stop_blocks} | verificou: {verificou}".format(**info))
PY

echo "[$ARM-$REP] exit=$STATUS em $((END-START))s" >&2
exit 0
