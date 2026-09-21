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

---

# Experimento 5 — Verificação iterativa sem LLM

**Hipótese:** boa parte dos `needs_context` pode ser resolvida com busca
determinística, sem acionar a LLM.

**Implementação:** quando o Jev devolve `needs_context`, extraímos os arquivos
citados no texto do achado, verificamos quais NÃO estão no diff, lemos esses
arquivos do disco (com casamento por sufixo, porque o achado costuma citar
`internal/middleware/routes.go` enquanto o arquivo real está sob
`packages/api-go/`) e perguntamos ao Jev de novo, só sobre os pendentes.

## Funcionou — e foi decisivo

Caso do prefixo de rota, que na primeira passada era `needs_context`
(evidência 0,34):

1. extraiu `internal/middleware/routes.go` do texto do achado;
2. achou o arquivo por sufixo e leu (848 bytes);
3. o arquivo **contém** `"/api/v1/customers/"` — a rota ESTÁ registrada;
4. Jev rejeitou o achado. **Rejeição correta.**

Custo: ~16k tokens de Jev, 1,2 s. Nenhuma chamada de LLM.

## Mas revelou um risco real: rejeição falsa

No mesmo teste, o achado do `numericFloat` (defeito verdadeiro — o código de
fato engole o erro e devolve 0) foi **rejeitado**. Investigando: o achado
citava `internal/fiado/fiado.go`, mas nesta implementação o código está em
`pending.go`. O arquivo citado não existia, então a premissa parecia falsa.

Com o caminho corrigido, o mesmo achado voltou a **confirmed (v=0,77,
e=0,79)**.

**A lição:** o retrieval aumenta a DECISIVIDADE, e isso corta para os dois
lados. Ele converte `needs_context` em `confirmed`/`rejected` — e uma rejeição
errada é pior que um `needs_context`, porque o achado some em vez de ir para
revisão humana.

Mitigação recomendada antes de ligar por padrão: quando o arquivo citado não
for encontrado, **não rejeitar** — manter `needs_context` com o motivo
"caminho citado não existe", que é informação útil por si só (o revisor errou a
localização, ou o código mudou).

## Estado

Implementado e testado, **mas não recomendado como padrão ainda** por causa do
risco de rejeição falsa. A mitigação acima é uma mudança pequena e deveria vir
antes de qualquer uso automático.

---

# Experimentos restantes — avaliação sem executar

Com o que os dados já mostram, dois deles mudaram de prioridade:

**Jev Scout (Exp. 1)** — redesenhado: em vez de filtrar o que a LLM analisa,
**entregar pronto o que o subagente iria investigar**. Ele gastou turnos com
`go build`, `cat`, `grep` e `ls`. Um pre-fetch determinístico desses fatos
(arquivos gerados existem? build passa? símbolo existe?) encurtaria a
investigação sem tirar informação. É o que tem maior potencial agora, porque
ataca os 82% do custo sem cortar qualidade.

**Context Routing (Exp. 2)** — mesma lógica, mas com um alerta medido: na
v2.5, estreitar o contexto **aumentou a ancoragem** (cobertura caiu de 9/10
para 8/10 enquanto o achado crítico melhorava). Estreitar demais faz o
subagente sair investigando de novo, que é justamente o custo que queremos
evitar.

**Atomic Questions (Exp. 3)** — o risco de recall subiu na minha avaliação.
Nesta última rodada o achado de maior severidade foi *"sqlc não foi regenerado:
não existe internal/db/fiado.sql.go"*. Nenhuma lista de perguntas fixas teria
essa pergunta. Vale como **complemento** da review ampla, nunca como
substituto.

**Adaptive Review (Exp. 4)** — depende de calibração e hoje temos n=1 por
protocolo. Prematuro.
