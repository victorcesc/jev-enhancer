# Experimento F — o decision space tira trabalho da LLM?

Hipótese: se a parte estrutural do code review virar perguntas fechadas, a LLM
para de fazer descoberta aberta e passa a fazer investigação dirigida — mais
barata pelo mesmo recall.

**Resposta: não. O decision space melhora o review e o encarece.**

Ele não substitui trabalho da LLM; ele dirige *mais* trabalho.

## Desenho

| braço | fluxo |
| --- | --- |
| **F0** | review aberta ("ache o que estiver errado") — as 3 execuções do D3 |
| **F1** | decision space determinístico → mapa de 65 pistas → LLM, livre para achar fora do mapa |

Mesmo snapshot, mesmo modelo (`claude-opus-5`), mesmo protocolo de worker. O
Jev **não está no caminho decisório de nenhum dos dois**
(ver `DECISAO-JEV-OBSERVADOR.md`). Única variável: a LLM recebe ou não o mapa.

## Resultado

| | F0 | F1 | delta |
| --- | --- | --- | --- |
| achados | 11,3 | 12,0 | +6% |
| recall | 39,5% (33–44%) | 43,2% (37–48%) | +9,4% |
| **severidade** | **49,1% (42–56%)** | **50,0% (44–56%)** | **+1,9%** |
| **tokens** | **1.910.316** | **2.752.911** | **+44,1%** |
| custo | $2,17 | $2,99 | +37,9% |
| turnos do worker | 26,3 | 29,3 | +11,4% |
| tempo | 292s | 377s | +29% |

**Critério de sucesso definido antes de rodar:** ≥90% do recall do baseline com
≥30% de redução de custo. F1 entrega **+9% de recall com +44% de custo** —
falha pelo lado oposto ao esperado.

As faixas de recall se sobrepõem quase inteiramente (33–44% contra 37–48%) e as
de severidade praticamente coincidem (42–56% contra 44–56%). **O ganho de
qualidade não é conclusivo.** O aumento de custo é: as faixas de token não se
tocam (1,73–2,06M contra 2,57–3,04M).

## Onde o custo aparece

O mapa tem 26.157 chars (~6.500 tokens) e acrescenta **50% ao contexto do
worker**. Relido a cada turno, são ~200k tokens só de mapa.

Mas isso é minoria dos 840k extras. O resto é o worker **investigando mais**:
29,3 turnos contra 26,3. O mapa dá 65 lugares concretos para olhar, e ele olha.

Isso é coerente com o resultado de qualidade: paga-se mais e recebe-se um pouco
mais. Não é ineficiência — é outro ponto na mesma curva.

## Serendipidade caiu

`from_candidate` foi registrado em cada achado. Nas 3 execuções:

```
32 achados vieram de candidatos do mapa
 4 achados foram descobertos fora dele   (11%)
```

O protocolo dizia explicitamente que o mapa é incompleto e que defeito fora
dele vale igual. Ainda assim, 89% dos achados saíram da lista.

Isso é ancoragem — manifestada por comportamento, não por instrução. E é o
risco que mais importa aqui: **num snapshot que o gerador não viu, a cobertura
do mapa cai e a ancoragem continua.** O teto do review passaria a ser o teto do
gerador.

## O que o experimento mostrou de positivo

**A compilação determinística funciona como compilação.** 65 candidatos em
68ms, sem LLM e sem rede, cobrindo 18 dos 27 defeitos e 75% da severidade,
com 100% dos `high` e `med`. Isso é real e barato.

**E o mapa antecipa bem:** dos 12 achados médios do F1, 11 já estavam
previstos como candidato. A estrutura do problema É largamente derivável do
diff.

O que não se confirmou foi a ponte econômica entre as duas coisas: saber onde
olhar não fez a LLM olhar menos.

## Ressalvas

- **n=3 por braço**, um snapshot, um modelo.
- **O gerador foi desenvolvido contra este catálogo** (ver o cabeçalho
  congelado em `src/decisions.mjs`). A cobertura de 75% é número de
  desenvolvimento. Num snapshot inédito ela cai, e com ela o ganho de recall —
  enquanto o custo do mapa permanece.
- F0 reaproveita as execuções do D3, que rodaram com o mesmo protocolo e
  snapshot mas em outro momento.

## O que fazer com isso

1. **Não adotar o decision space como está.** Ele não paga o próprio custo.
2. **Testar a versão comprimida antes de descartar.** 23 dos 65 candidatos são
   regras do repo que poderiam virar uma linha; as linhas de evidência podem
   sair. Um mapa de ~2k tokens em vez de 6,5k separa "o mapa ajuda" de "o mapa
   custa contexto".
3. **A prova real continua pendente:** snapshot que o gerador nunca viu. Sem
   isso não dá para distinguir cobertura real de memorização do catálogo.
4. **Se a versão comprimida também não reduzir custo**, a conclusão é que
   review aberta com bom protocolo já é próxima do ótimo para este modelo, e o
   valor do projeto está onde as medições anteriores apontaram: o gatilho
   automático e a triagem determinística — não a estruturação prévia.
