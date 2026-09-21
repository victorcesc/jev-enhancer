#!/usr/bin/env python3
"""Pontua execuções do experimento A/B/C contra o known defect set.

    ./score.py runs/a-1 [runs/b-1 ...]      # detalhe por execução
    ./score.py --matrix                      # matriz defeito x braço

Casamento é por palavra-chave (`match_any` em known-defects.yaml) sobre o
texto do achado. É heurístico de propósito: serve para triagem rápida, e o
que sobra sem casar (`unmatched`) é exatamente o que eu preciso auditar à
mão — ou é defeito novo, ou é falso positivo. Nunca é descartado em silêncio.
"""
import json
import sys
import unicodedata
from pathlib import Path

import yaml

HERE = Path(__file__).resolve().parent
KNOWN = yaml.safe_load((HERE / "known-defects.yaml").read_text())
DEFECTS = KNOWN["defects"]


def norm(s: str) -> str:
    """minúsculas sem acento — o modelo alterna entre 'transação' e 'transacao'."""
    s = unicodedata.normalize("NFD", (s or "").lower())
    return "".join(c for c in s if unicodedata.category(c) != "Mn")


def finding_text(f: dict) -> str:
    parts = [f.get(k, "") for k in ("file", "symbol", "issue", "summary", "title", "detail")]
    return norm(" ".join(str(p) for p in parts))


def match(f: dict):
    """Defeitos conhecidos compatíveis com este achado, mais forte primeiro."""
    text = finding_text(f)
    hits = []
    for d in DEFECTS:
        n = sum(1 for kw in d["match_any"] if norm(kw) in text)
        if n:
            hits.append((n, d["id"]))
    hits.sort(reverse=True)
    return [i for _, i in hits]


def _from_transcript(run: Path):
    """Resgata os achados do texto da resposta quando o arquivo não saiu.

    Uma execução onde o `Write` foi negado ainda fez o review inteiro; perder
    os achados por causa da permissão seria jogar fora dado bom. Procura um
    bloco ```json com `findings`, e, se não houver, um objeto JSON solto.
    """
    p = run / "result.json"
    if not p.exists():
        return None
    try:
        text = (json.loads(p.read_text()).get("result") or "")
    except Exception:
        return None
    import re

    blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    blocks += re.findall(r'(\{\s*"findings"\s*:\s*\[.*?\]\s*\})', text, re.S)
    for b in blocks:
        try:
            d = json.loads(b)
        except Exception:
            continue
        if isinstance(d, dict) and isinstance(d.get("findings"), list) and d["findings"]:
            return d["findings"]
    return None


def load_findings(run: Path):
    p = run / "findings.json"
    if p.exists():
        data = json.loads(p.read_text())
        return data["findings"] if isinstance(data, dict) else data
    return _from_transcript(run)


def score(run: Path):
    fs = load_findings(run)
    if fs is None:
        return None
    assigned, unmatched, dupes = {}, [], []
    for f in fs:
        ids = match(f)
        # um achado só pode reivindicar um defeito; o primeiro não tomado vence
        for i in ids:
            if i not in assigned:
                assigned[i] = f
                break
        else:
            (dupes if ids else unmatched).append(f)
    found = set(assigned)
    return {
        "run": run.name,
        "arm": run.name.split("-")[0],
        "n_findings": len(fs),
        "found_known": sorted(found),
        "missed_known": sorted({d["id"] for d in DEFECTS} - found),
        "unmatched": unmatched,
        "collisions": dupes,
        "recall": len(found) / KNOWN["known_total"],
        "sev_recall": _sev_recall(found),
    }


def _sev_recall(found):
    w = {"high": 3, "med": 2, "low": 1}
    tot = sum(w[d["severity"]] for d in DEFECTS)
    got = sum(w[d["severity"]] for d in DEFECTS if d["id"] in found)
    return got / tot


def seconds(run: Path):
    p = run / "seconds.txt"
    return int(p.read_text().strip()) if p.exists() else None


def usage(run: Path):
    p = run / "result.json"
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text())
    except Exception:
        return {}
    u = d.get("usage") or {}
    tot = sum(u.get(k, 0) for k in
              ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
    return {"cost_usd": d.get("total_cost_usd"), "tokens": tot,
            "output_tokens": u.get("output_tokens"), "turns": d.get("num_turns")}


def report(run: Path):
    s = score(run)
    if not s:
        print(f"{run.name}: sem findings.json")
        return None
    u = usage(run)
    print(f"\n=== {run.name} ===")
    print(f"achados: {s['n_findings']}  |  known encontrados: {len(s['found_known'])}/{KNOWN['known_total']}"
          f"  (recall {s['recall']:.0%}, ponderado por severidade {s['sev_recall']:.0%})")
    if u:
        print(f"tokens: {u.get('tokens'):,}  custo: ${u.get('cost_usd') or 0:.2f}  "
              f"turnos: {u.get('turns')}  tempo: {seconds(run)}s")
    print(f"achou: {', '.join(s['found_known'])}")
    print(f"perdeu: {', '.join(s['missed_known'])}")
    if s["unmatched"]:
        print(f"NÃO CASOU ({len(s['unmatched'])}) — auditar à mão:")
        for f in s["unmatched"]:
            print(f"   [{f.get('severity','?')}] {f.get('file','?')} :: {f.get('symbol','?')}")
            print(f"      {' '.join(str(f.get('issue') or f.get('summary') or '').split())[:150]}")
    if s["collisions"]:
        print(f"COLISÃO ({len(s['collisions'])}) — casaram com defeito já reivindicado:")
        for f in s["collisions"]:
            print(f"   [{f.get('severity','?')}] {f.get('file','?')} :: {f.get('symbol','?')}")
    return s


def matrix():
    runs = sorted(p for p in (HERE / "runs").iterdir() if p.is_dir())
    scored = [s for s in (score(r) for r in runs) if s]
    if not scored:
        print("nenhuma execução pontuada ainda")
        return
    arms = sorted({s["arm"] for s in scored})
    per_arm = {a: [s for s in scored if s["arm"] == a] for a in arms}
    w = max(len(d["id"]) for d in DEFECTS) + 2
    print(f"\n{'defeito'.ljust(w)}{'sev'.ljust(6)}" + "".join(a.upper().center(8) for a in arms))
    print("-" * (w + 6 + 8 * len(arms)))
    for d in DEFECTS:
        row = f"{d['id'].ljust(w)}{d['severity'].ljust(6)}"
        for a in arms:
            rs = per_arm[a]
            hit = sum(1 for s in rs if d["id"] in s["found_known"])
            row += f"{hit}/{len(rs)}".center(8)
        print(row)
    print("-" * (w + 6 + 8 * len(arms)))
    row = f"{'RECALL MÉDIO'.ljust(w)}{''.ljust(6)}"
    for a in arms:
        rs = per_arm[a]
        row += f"{sum(s['recall'] for s in rs) / len(rs):.0%}".center(8)
    print(row)
    row = f"{'ACHADOS MÉDIOS'.ljust(w)}{''.ljust(6)}"
    for a in arms:
        rs = per_arm[a]
        row += f"{sum(s['n_findings'] for s in rs) / len(rs):.1f}".center(8)
    print(row)


def diversity():
    """Experimento B — recall da UNIÃO de k workers independentes.

    Sai de graça das repetições já feitas: unir k execuções do mesmo braço é
    exatamente o que k workers paralelos produziriam. Mede o retorno
    decrescente de cada worker adicional sem gastar execução nova.
    """
    from itertools import combinations

    runs = sorted(p for p in (HERE / "runs").iterdir() if p.is_dir())
    scored = [s for s in (score(r) for r in runs) if s]
    arms = sorted({s["arm"] for s in scored})
    print(f"\n{'braço':8}{'k':>3}{'recall união':>16}{'marginal':>12}")
    print("-" * 39)
    for a in arms:
        rs = [s for s in scored if s["arm"] == a]
        prev = None
        for k in range(1, len(rs) + 1):
            vals = [len(set().union(*(set(s["found_known"]) for s in combo))) / KNOWN["known_total"]
                    for combo in combinations(rs, k)]
            avg = sum(vals) / len(vals)
            marg = "—" if prev is None else f"+{(avg - prev) * KNOWN['known_total']:.1f} bugs"
            print(f"{a:8}{k:>3}{avg:>15.0%}{marg:>12}")
            prev = avg
    # união entre braços diferentes: diversidade vem do protocolo, não do sorteio
    if len(arms) > 1:
        print(f"\n{'união entre braços distintos (1 execução de cada)':<40}")
        seeds = {s["run"] for s in scored if s["run"].endswith("-pilot")}
        for combo in combinations(arms, 2):
            picked, is_seed = [], True
            for a in combo:
                rs = [s for s in scored if s["arm"] == a]
                picked.append(set(rs[0]["found_known"]))
                is_seed &= rs[0]["run"] in seeds
            u = len(set().union(*picked)) / KNOWN["known_total"]
            flag = "  <- CIRCULAR: estas execuções DEFINIRAM o known set" if is_seed else ""
            print(f"  {' + '.join(combo):<20}{u:>8.0%}{flag}")


def verify_effect():
    """O que o Jev Verify adiciona e o que ele custa (só braço B).

    `findings.json` é o bruto que o subagente gerou; `findings-verified.json`
    é o que sobrou depois da triagem. A diferença entre os dois, medida contra
    o known defect set, separa as duas coisas que importam:

      - falso positivo rejeitado  -> ganho de precisão
      - defeito CONHECIDO rejeitado -> falsa rejeição, o dano que preocupa
    """
    runs = sorted(p for p in (HERE / "runs").iterdir() if p.is_dir())
    rows = []
    for run in runs:
        vf = run / "jev-dir" / "findings-verified.json"
        raw = run / "findings.json"
        if not (vf.exists() and raw.exists()):
            continue
        before = json.loads(raw.read_text())
        before = before["findings"] if isinstance(before, dict) else before
        after_doc = json.loads(vf.read_text())
        after = after_doc.get("findings", [])
        kb = {i for f in before for i in match(f)[:1]}
        ka = {i for f in after for i in match(f)[:1]}
        rows.append({
            "run": run.name,
            "mode": after_doc.get("mode"),
            "verdicts": after_doc.get("verdicts", {}),
            "n_before": len(before), "n_after": len(after),
            "known_before": len(kb), "known_after": len(ka),
            "known_perdidos": sorted(kb - ka),
        })
    if not rows:
        print("nenhuma execução com triagem do Jev ainda")
        return
    print(f"\n{'execução':12}{'modo':7}{'achados':>12}{'known':>10}  veredictos")
    print("-" * 68)
    for r in rows:
        print(f"{r['run']:12}{str(r['mode']):7}"
              f"{r['n_before']:>5} -> {r['n_after']:<4}"
              f"{r['known_before']:>5} -> {r['known_after']:<4}  "
              + ", ".join(f"{k}={v}" for k, v in sorted(r["verdicts"].items())))
        if r["known_perdidos"]:
            print(f"{'':12}FALSA REJEIÇÃO: {', '.join(r['known_perdidos'])}")
    total_lost = sum(len(r["known_perdidos"]) for r in rows)
    dropped = sum(r["n_before"] - r["n_after"] for r in rows)
    print("-" * 68)
    print(f"descartados no total: {dropped}  |  defeitos conhecidos perdidos: {total_lost}")
    if dropped and not total_lost:
        print("o Jev só tirou achados fora do known set — ou falso positivo, ou defeito novo.")
        print("auditar os descartados à mão antes de creditar precisão ao verificador.")


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "--matrix":
        matrix()
    elif args[0] == "--diversity":
        diversity()
    elif args[0] == "--verify-effect":
        verify_effect()
    else:
        for a in args:
            report(Path(a) if Path(a).is_absolute() else HERE / a)
