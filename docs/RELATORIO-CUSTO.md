# Relatório — onde vive o custo do review

Três execuções reais da mesma feature (`GET /customers/{id}/fiado`) no mesmo
repo, modelo `claude-opus-5`, medindo sessão principal **e** subagentes.

## Resultado consolidado

| protocolo | principal | subagente | **TOTAL** | achados | confirmados |
| --- | --- | --- | --- | --- | --- |
| orquestrado (5 passos na sessão) | 1.229.260 / 9 turnos | 1.954.287 / 31 turnos | **3.183.547** | 5 | 4 |
| uma ida e volta | 529.394 / 4 turnos | 1.795.936 / 24 turnos | **2.325.330** | 9 | 7 |
| **Exp 0 — prompt sem passos** | **325.590 / 3 turnos** | 1.506.201 / 26 turnos | **1.831.791** | **10** | **10** |

Do primeiro ao último: **−42% de custo com o dobro de achados confirmados.**

## Correção importante de medição

A primeira medição do "uma ida e volta" reportou −57%. Estava errada: contava
só a sessão principal. Subagentes têm transcript próprio
(`<sessão>/subagents/*.jsonl`) e eram **77-82% do custo** — invisíveis.
O ganho real daquele experimento foi 26%, não 57%. O `inspect` agora
contabiliza os dois.

## Experimento 0: a hipótese falhou

**Hipótese:** o subagente gastava 24 turnos porque o prompt pedia 5 passos
sequenciais; reescrevê-lo como 3 ações reduziria os turnos.

**Resultado:** os turnos **subiram** (24 → 26). A queda de tokens veio de o
contexto ser menor nesta corrida (51.854 vs 56.887 chars) e da implementação
ser menor — variância, não o prompt.

**Por que falhou:** olhando as ferramentas que o subagente usou, ele não estava
gastando turnos com cerimônia. Ele estava **investigando o repositório**:

```
Bash×7  (go build, cat, grep, ls, verify)
Read×3
Grep×1
Write×1
```

Ele lê o contexto preparado e depois vai conferir o código de verdade.

**E essa investigação compra qualidade.** O achado de maior severidade desta
rodada (2,99) foi: *"sqlc não foi regenerado: não existe
internal/db/fiado.sql.go"* — só é possível afirmar isso olhando o sistema de
arquivos, não o diff.

Resultado desta rodada: **10 achados, 10 confirmados, 0 needs_context,
0 rejeitados** — a melhor qualidade das três.

## A conclusão que reorienta o trabalho

```
custo ≈ turnos × contexto_acumulado
```

- Na **sessão principal**, os turnos eram cerimônia de orquestração. Eliminá-los
  foi puro ganho: 9 → 3 turnos, sem perder nada. Feito.
- No **subagente**, os turnos são investigação. Cortá-los custa qualidade.

Ou seja: **82% do custo do review é o preço de investigar o repositório**, e
esse gasto está comprando os achados que justificam a ferramenta.

## O que isso implica para os experimentos de Control Plane

**Jev Scout (Exp. 1)** — muda de "filtrar o que a LLM analisa" para algo mais
promissor: **dar ao subagente o que ele iria buscar**. Ele gastou turnos
rodando `go build`, `cat` e `grep`. Se o contexto já trouxesse esses fatos
(arquivos gerados presentes? build passa? símbolo existe?), a investigação
encurtaria sem perder a informação. Isso aproxima o Scout de um *pre-fetch
determinístico*, não de um filtro.

**Context Routing (Exp. 2)** — mesma lógica: o valor não é estreitar, é
antecipar. Estreitar aumenta a chance de o subagente sair investigando de novo.

**Atomic Questions (Exp. 3)** — continua sendo o uso mais nativo do Jev, mas o
risco de recall subiu na minha avaliação: perguntas fixas não teriam achado o
sqlc não regenerado, porque ninguém pensaria em perguntar isso.

**Adaptive Review (Exp. 4)** — fica mais atraente por outro motivo: se o custo
é investigação, faz sentido investigar menos em diff trivial.

**Iterative Verification (Exp. 5)** — segue sendo o mais barato e elegante.
Nesta rodada, porém, não houve nenhum `needs_context` para resolver.

## Recomendação

Parar de otimizar o custo do review por ora. Aos números atuais — **6,3% de
overhead na sessão, 10 achados confirmados, um bug de produção encontrado** —
a relação custo/benefício já é boa, e cada corte adicional agora arrisca a
qualidade que justifica a ferramenta.

O próximo ganho real não está em economizar tokens: está em **reduzir a
investigação do subagente entregando os fatos prontos** (pre-fetch
determinístico). É o Scout, redesenhado com esse propósito.

## Ressalvas

- n=1 por protocolo, uma tarefa, um repo. As implementações diferem entre
  rodadas, então a comparação de achados não é perfeitamente pareada.
- "10 confirmados" é o veredito do Jev, não ground truth auditada.
- O overhead de 6,3% é da sessão principal; sobre o custo total da sessão
  (implementação + review), o review é ~26%.
