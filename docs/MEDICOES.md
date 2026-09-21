# Medições — teste ponta a ponta do jev-enhancer

Duas execuções reais: agente implementa a feature `GET /customers/{id}/fiado`
num worktree do `pdv`, com o adapter instalado. Modelo `claude-opus-5`.

A rodada 1 rodou com um bug meu (diff sem o conteúdo dos arquivos novos); a
rodada 2, depois do fix. As duas estão aqui porque a comparação ensina.

## Tempo

| etapa | tempo |
| --- | --- |
| hook (guard + gate + prepare + block) | **42 ms** |
| triagem Jev (5 achados) | **1,4 s** |
| review completo (orquestração + 2 subagentes) | ~12% dos turnos da sessão |
| sessão inteira (implementação + review) | 14,8 min |

O hook é imperceptível. A triagem do Jev também. O custo de tempo do review
está na orquestração e nos subagentes, não na ferramenta.

## Tokens e custo

Faturado na sessão (rodada 2): **8,52 M de cache read + 79,6 k de saída =
$8,48**.

| item | tokens | custo |
| --- | --- | --- |
| implementação | ~79% | ~$6,70 |
| **review** | **~21%** | **~$1,78** |
| triagem Jev | 19.764 | **$0,0008** |

O Jev é gratuito na prática. O custo do review é a LLM rodando os dois passes
e o agente orquestrando.

**Achado importante:** o review custa ~15× mais dentro de uma sessão longa do
que numa sessão isolada (~120 k tokens). Os subagentes mantêm a *análise*
barata, mas os turnos de orquestração do agente principal carregam todo o
contexto acumulado e são re-cobrados. É o limite estrutural do desenho
"review dentro da sessão".

## Qualidade

### Rodada 2 (diff correto)

5 achados: **4 confirmados, 1 needs_context, 0 rejeitados**. Evidência entre
0,37 e 0,73 — o Jev conseguia julgar.

O que achou: overflow no cálculo do offset; stub que grava argumentos e nunca
os verifica; regra de negócio do fiado sem teste; campo `Document` nunca
asseverado; dois ramos de erro não exercitados.

Nesta rodada o agente **registrou a rota** no `bearerRoutePrefixes`
corretamente — então não havia o bug clássico para encontrar. O código saiu
melhor, não o review pior.

### Rodada 1 (diff quebrado) — e o que ela provou

16 achados, mas o Jev marcou 10 como `needs_context` com evidência ~0,38.
Investigando: o diff tinha **29 linhas de conteúdo** quando os arquivos novos
somavam 928. O `collectDiff` emitia só o cabeçalho dos arquivos não
rastreados.

**O sinal `evidence_sufficient` detectou um bug do próprio produto.** Depois
do fix, com os mesmos 16 achados:

| | antes | depois |
| --- | --- | --- |
| conteúdo no diff | 29 linhas | 1.496 linhas |
| confirmados | 6 | 15 |
| needs_context | 10 | 1 |
| evidência média | ~0,38 | ~0,68 |

Se evidência baixa fosse tratada como "achado falso", 10 achados válidos
teriam sido descartados e o bug nunca apareceria.

## Fluxo (as duas rodadas)

| verificação | r1 | r2 |
| --- | --- | --- |
| hook disparou | sim | sim |
| bloqueios emitidos | 1 (de 4 invocações) | 1 (de 4) |
| subagentes usados | 2 | 2 |
| verify executado | sim | sim |
| read-only respeitado | sim | sim |
| loop | não | não |

## Vale a pena?

**A favor:** ~$1,78 por review contra uma sessão de depuração de bug escapado,
que pelas nossas medições custa entre 500 k e 3,4 M tokens. Catchar um bug a
cada 2-3 reviews já paga. E no teste retroativo sobre bugs reais do
`new-space-game`, o review acertou 2/2 na condição de campo.

**Contra, honestamente:**
- O review **não economiza** na sessão: adiciona ~21%. A economia é a jusante.
- **Zero rejeições** nas duas rodadas. O teste de estresse mostrou que o filtro
  rejeita 7 de 8 alucinações plantadas, então ele funciona — mas nestes casos
  reais não houve ruído para filtrar, então essa capacidade não foi exercitada
  em campo.
- Sem ground truth para a rodada 2, "4 confirmados" é o julgamento do Jev, não
  verdade verificada.
- n=2 execuções, uma tarefa, um repo.

## O que ficou pendente

- A camada determinística não disparou (0 achados): os checks são do `pdv` e
  este repo não tem `prrules` configurado. Num repo com `deterministic.commands`
  configurado, ela entra sem custo de tokens.
- Medir o review em sessão isolada versus dentro da sessão, para quantificar
  exatamente o preço de rodar "dentro".

---

# Diagnóstico: por que o review integrado custa ~15× o isolado

Análise turno a turno da fase de review (rodada 2), **deduplicada** — o
transcript registra cada mensagem mais de uma vez, e somar todas dobra os
números (erro que inflou o primeiro relatório em ~2×).

## A anatomia

| componente | tokens | share |
| --- | --- | --- |
| contexto re-cobrado (cache_read) | 1.208.910 | **98,3%** |
| cache novo | 14.406 | 1,2% |
| **trabalho real (output)** | **5.944** | **0,5%** |
| total da fase de review | 1.229.260 | |

**9 turnos × 134.323 de contexto acumulado = 1,2 M.**

## A conclusão

O trabalho de review é praticamente grátis: 5.944 tokens de saída. Todo o
resto é o preço de existir dentro de uma sessão grande — cada turno de
orquestração re-lê os ~134 k de contexto acumulado.

```
custo ≈ turnos_na_sessão_principal × contexto_acumulado
```

Isso explica a diferença medida:
- **isolado**: 1-2 turnos × contexto pequeno ≈ 120 k
- **integrado**: 9 turnos × 134 k ≈ 1,2 M

Não é a análise que custa. É a orquestração.

## O alvo

Reduzir TURNOS na sessão principal, não reduzir análise:

| turnos | custo projetado | redução |
| --- | --- | --- |
| 9 (hoje) | 1.208.910 | — |
| 2 (uma ida e volta) | 268.646 | **78%** |

2 turnos é o piso teórico: o agente chama a ferramenta (1) e recebe o
resultado (1). Tudo além disso é orquestração evitável.

Isso valida a hipótese do worker único: o ganho não vem de juntar os dois
passes num agente só — vem de o agente principal não orquestrar etapa por
etapa. Os passes podem continuar dois, desde que aconteçam **atrás de uma
única chamada**.

## Correção do relatório anterior

Os números publicados antes estavam inflados ~2× pela dupla contagem:

| | antes (errado) | correto |
| --- | --- | --- |
| implementação | 11,0 M / 125 turnos | 5,7 M / 62 turnos |
| review | 2,3 M / 17 turnos | 1,23 M / 9 turnos |
| % do review | 21,0% | 21,6% |

A proporção se manteve (o erro afetava os dois lados igualmente), mas os
absolutos não. O `inspect` agora deduplica por id de mensagem.

---

# Experimento 2 — tool como happy path (uma ida e volta)

## A mudança

O protocolo inteiro (duas análises + consolidação + triagem) saiu da sessão
principal e foi para `.jev/review-prompt.md`, lido pelo SUBAGENTE. A sessão
principal passou a fazer só: chamar (1 turno) e apresentar (1 turno).

A instrução injetada caiu de 1.370 para **737 caracteres**.

## Resultado medido

| | protocolo orquestrado | uma ida e volta |
| --- | --- | --- |
| turnos no review | 9 | **4** |
| tokens do review | 1.229.260 | **529.394** |
| % da implementação | 21,6% | **6,9%** |
| ferramentas na sessão principal | Agent, Bash, Bash | **Agent** |

**Redução de 57%** no custo do review, sem tocar no Jev nem na análise.

A prova de que o desenho funcionou está nas ferramentas: a sessão principal
agora faz **uma única chamada `Agent`**. O `jev verify` sumiu do transcript
principal porque passou a rodar dentro do subagente — onde é barato.

## Qualidade preservada (ou melhor)

9 achados: **7 confirmados, 2 needs_context, 0 rejeitados**.

E pegou o defeito de maior severidade (s=2,99): *"a nova rota é montada em
/api/v1/customers, prefixo que não está em middleware..."* — a classe de bug
que o baseline explorando livre só encontra em 2 de 6 corridas. Marcado como
`needs_context` (evidência 0,34) porque o conteúdo da config não está no diff,
exatamente como esperado.

Também achou: todos os testes HTTP montarem `chi.NewRouter()` cru sem o
middleware (por isso o bug do prefixo passa nos testes), `numericFloat`
engolindo erro, três caminhos de falha descartando o erro original, e dois
donos da regra de paginação.

## Por que 4 turnos e não 2

O piso teórico é 2 (chamar + receber). Os 2 turnos extras são texto puro, sem
ferramenta — o agente compondo antes e depois da chamada. Espremer isso daria
mais ~130 k por turno economizado, mas exige controlar a verbosidade do agente,
que é menos determinístico que mover trabalho para o subagente.

Custo projetado se chegar a 2 turnos: ~259 k (−79% do original).

## Conclusão

A hipótese estava certa e o efeito é grande: **o custo do review não estava na
análise, estava na orquestração**. Mover o protocolo para dentro do subagente
resolveu mais da metade do problema com uma mudança de prompt — sem alterar
Jev, verifier, gate ou qualquer lógica de análise.
