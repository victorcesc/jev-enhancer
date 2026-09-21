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
