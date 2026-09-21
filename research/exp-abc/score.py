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


PROJECT_DIR = Path.home() / ".claude/projects/-Users-cesc-Projects-pdv-feat-baseline"

_TOK = ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")


def _transcript_tokens(path: Path):
    """Tokens de um transcript, deduplicando por message.id.

    A dedupe não é opcional: o mesmo assistant message aparece várias vezes no
    .jsonl, e somar tudo infla o total em ~2x. Já reportei número errado por
    causa disso uma vez.
    """
    seen = {}
    try:
        for line in path.read_text().splitlines():
            try:
                d = json.loads(line)
            except Exception:
                continue
            m = d.get("message") or {}
            if d.get("type") == "assistant" and m.get("id"):
                seen[m["id"]] = m.get("usage") or {}
    except Exception:
        return 0, 0
    return sum(sum(u.get(k, 0) for k in _TOK) for u in seen.values()), len(seen)


def subagent_cost(session_id: str):
    """Custo dos subagentes desta sessão — invisível no result.json.

    O braço B move a análise inteira para um subagente, que tem transcript
    separado. Ignorar isso faz o braço B parecer ~10x mais barato do que é.
    """
    d = PROJECT_DIR / (session_id or "") / "subagents"
    if not d.is_dir():
        return 0, 0
    tot = turns = 0
    for f in d.glob("*.jsonl"):
        t, n = _transcript_tokens(f)
        tot += t
        turns += n
    return tot, turns


def usage(run: Path):
    p = run / "result.json"
    if not p.exists():
        return {}
    try:
        d = json.loads(p.read_text())
    except Exception:
        return {}
    u = d.get("usage") or {}
    main = sum(u.get(k, 0) for k in _TOK)
    sub, sub_turns = subagent_cost(d.get("session_id"))
    return {"cost_usd": d.get("total_cost_usd"), "tokens": main + sub,
            "main_tokens": main, "sub_tokens": sub, "sub_turns": sub_turns,
            "output_tokens": u.get("output_tokens"), "turns": d.get("num_turns"),
            # turnos gastos em tentativa negada inflam o custo sem produzir
            # análise: execução com negação não é pareável com uma sem.
            "denials": len(d.get("permission_denials") or [])}


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
        extra = (f"  (principal {u['main_tokens']:,} + subagente {u['sub_tokens']:,}"
                 f" em {u['sub_turns']} turnos)" if u.get("sub_tokens") else "")
        print(f"tokens: {u.get('tokens'):,}{extra}")
        warn = f"  [{u['denials']} negacao(oes) de permissao — custo inflado]" if u.get("denials") else ""
        print(f"custo: ${u.get('cost_usd') or 0:.2f}  turnos principais: {u.get('turns')}"
              f"  tempo: {seconds(run)}s{warn}")
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


def summary():
    """Agregado por braço, com faixa — média sozinha esconde a variância.

    Com n=2-3 a faixa importa mais que a média: se o pior do braço melhor
    empata com o melhor do braço pior, a diferença não é conclusiva.
    """
    runs = sorted(p for p in (HERE / "runs").iterdir() if p.is_dir())
    data = {}
    for r in runs:
        s = score(r)
        if not s:
            continue
        u = usage(r)
        data.setdefault(s["arm"], []).append((s, u, seconds(r)))
    print(f"\n{'braço':7}{'n':>3}{'achados':>20}{'recall':>20}{'tokens':>26}{'tempo':>18}")
    print("-" * 94)
    for arm in sorted(data):
        rs = data[arm]
        n = len(rs)
        ach = [s["n_findings"] for s, _, _ in rs]
        rec = [s["recall"] for s, _, _ in rs]
        tok = [u.get("tokens", 0) for _, u, _ in rs]
        sec = [t or 0 for _, _, t in rs]
        f = lambda v, fmt: f"{sum(v)/len(v):{fmt}} ({min(v):{fmt}}–{max(v):{fmt}})"
        print(f"{arm.upper():7}{n:>3}{f(ach,'.1f'):>20}{f(rec,'.0%'):>20}"
              f"{f(tok,',.0f'):>26}{f(sec,'.0f'):>18}")
    print("-" * 94)
    # Comparação PAR A PAR. Um veredito global esconde o caso em que A empata
    # com B mas B separa de C — foi exatamente o que aconteceu aqui.
    from itertools import combinations

    arms = sorted(data)
    if len(arms) < 2:
        return
    rec = {a: [s["recall"] for s, _, _ in data[a]] for a in arms}
    print("\ncomparações par a par (só conta como separação se as faixas não se tocam):")
    for x, y in combinations(arms, 2):
        mx, my = sum(rec[x]) / len(rec[x]), sum(rec[y]) / len(rec[y])
        hi, lo = (x, y) if mx > my else (y, x)
        if min(rec[hi]) > max(rec[lo]):
            print(f"  {hi.upper()} > {lo.upper()}   SEPARADO — pior caso de {hi.upper()} "
                  f"({min(rec[hi]):.0%}) supera o melhor de {lo.upper()} ({max(rec[lo]):.0%})")
        else:
            print(f"  {x.upper()} ~ {y.upper()}   empate — faixas se sobrepõem "
                  f"({min(rec[x]):.0%}–{max(rec[x]):.0%} vs {min(rec[y]):.0%}–{max(rec[y]):.0%})")


def saturation():
    """Quantos defeitos INÉDITOS cada execução acrescentou, em ordem cronológica.

    É a pergunta que decide se vale somar workers: se a curva achata, um
    review já cobre o espaço e diversidade não compra nada. Se não achata, o
    conjunto conhecido é um piso e todo recall medido contra ele é otimista.
    """
    runs = [p for p in (HERE / "runs").iterdir() if p.is_dir() and (p / "result.json").exists()]
    runs.sort(key=lambda p: (p / "result.json").stat().st_mtime)
    seen, rows = set(), []
    for r in runs:
        s = score(r)
        if not s:
            continue
        found = set(s["found_known"])
        novos = found - seen
        seen |= found
        rows.append((r.name, len(found), len(novos), len(seen)))
    if not rows:
        print("nenhuma execução pontuada")
        return
    print(f"\n{'execução':12}{'achou':>7}{'inéditos':>10}{'acumulado':>11}{'cobertura':>11}")
    print("-" * 51)
    for name, n, novos, acc in rows:
        print(f"{name:12}{n:>7}{novos:>10}{acc:>11}{acc / KNOWN['known_total']:>10.0%}")
    print("-" * 51)
    print("CIRCULAR: 'acumulado' chega a 100% por construção — o known set É a união")
    print("destas execuções. O que informa é a coluna 'inéditos', não a cobertura.")
    ultimos = [r[2] for r in rows[-3:]]
    if sum(ultimos) > 0:
        print(f"\nAs últimas 3 execuções ainda acrescentaram {sum(ultimos)} defeito(s) inédito(s):")
        print("a curva NÃO saturou. O known set é um piso e todo recall aqui é otimista.")
    else:
        print("\nAs últimas 3 execuções não acrescentaram nada: curva aparentemente saturada.")


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
    # A pergunta que decide o produto: pareando CUSTO, quem entrega mais?
    # Comparar 1 execução de B com 1 de C é injusto — B custa mais. O teste
    # honesto é comparar configurações de custo parecido.
    print(f"\n{'configuração':18}{'recall':>9}{'tokens':>14}{'defeitos/M tokens':>20}")
    print("-" * 61)
    linhas = []
    for a in arms:
        rs = [s for s in scored if s["arm"] == a]
        toks = [usage(HERE / "runs" / s["run"]).get("tokens", 0) for s in rs]
        medio = sum(toks) / len(toks)
        for k in range(1, len(rs) + 1):
            vals = [len(set().union(*(set(s["found_known"]) for s in combo))) / KNOWN["known_total"]
                    for combo in combinations(rs, k)]
            r = sum(vals) / len(vals)
            custo = medio * k
            linhas.append((f"{k}x {a.upper()}", r, custo,
                           r * KNOWN["known_total"] / (custo / 1e6)))
    for nome, r, custo, eff in sorted(linhas, key=lambda x: x[2]):
        print(f"{nome:18}{r:>8.0%}{custo:>14,.0f}{eff:>20.1f}")
    print("-" * 61)
    dom = [(n, r, c) for n, r, c in [(l[0], l[1], l[2]) for l in linhas]]
    for n1, r1, c1 in dom:
        piores = [n2 for n2, r2, c2 in dom if n2 != n1 and r2 <= r1 and c2 >= c1]
        if piores:
            print(f"{n1} domina (mais recall E menos tokens que): {', '.join(piores)}")

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
    elif args[0] == "--saturation":
        saturation()
    elif args[0] == "--summary":
        summary()
    else:
        for a in args:
            report(Path(a) if Path(a).is_absolute() else HERE / a)
