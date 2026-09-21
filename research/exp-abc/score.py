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


def load_findings(run: Path):
    p = run / "findings.json"
    if not p.exists():
        return None
    data = json.loads(p.read_text())
    return data["findings"] if isinstance(data, dict) else data


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


if __name__ == "__main__":
    args = sys.argv[1:]
    if not args or args[0] == "--matrix":
        matrix()
    elif args[0] == "--diversity":
        diversity()
    else:
        for a in args:
            report(Path(a) if Path(a).is_absolute() else HERE / a)
