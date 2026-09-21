# Auditoria de qualidade — os 10 achados da melhor rodada

Até aqui, "10 confirmados" era o **veredito do Jev**, não verdade verificada.
Esta auditoria lê o código real e julga cada achado à mão.

Rodada: Exp 0 (`a06f367b`), feature `GET /customers/{id}/fiado` no `pdv`.

## Resultado

**10 de 10 são defeitos reais. Precisão = 1,00. Zero falsos positivos.**

| # | sev | achado | verificação no código | veredito |
| --- | --- | --- | --- | --- |
| 1 | high | sqlc não regenerado; `internal/db/fiado.sql.go` não existe e o build quebra | `go build ./...` falha com **exatamente** os símbolos citados (`db.GetCustomerByUserIDAndIDParams`, `…Params`, `…Row`) | **REAL — crítico** |
| 2 | med | subquery de `payments` sem predicado, agrega a tabela inteira | confirmado: `SELECT sale_id, SUM(amount) FROM payments GROUP BY sale_id` sem `WHERE` | **REAL** |
| 3 | med | teste cria `otherUserID`/`otherCustomerID` mas nunca exercita o isolamento | as variáveis existem (linhas 38, 51, 99) e as chamadas de query usam só `userID`/`customerID` | **REAL** |
| 4 | med | erro de banco vira 500 genérico, sem `%w` e sem log | `internalError()` devolve `apperror.New(...)` fixo, descartando o erro de origem | **REAL** |
| 5 | med | ramo de fallback não-`AppError` nunca exercitado | o teste injeta `apperror.New(...)` — um `*AppError` —, então o `else` nunca roda | **REAL** |
| 6 | low | `numericFloat` engole erro e devolve 0 | `if err != nil \|\| !f.Valid { return 0 }` | **REAL** |
| 7 | low | validade do `timestamptz` descartada | `saleDate, _ := timestamptzTime(row.SaleDate)` (linha 77) | **REAL** |
| 8 | low | contrato de erro divergente entre middleware e handler | `apperror` escreve `error/code`; o handler escreve `success/message/code` | **REAL** |
| 9 | low | teste de contrato não desce em `pagination` | o teste checa topo (`success`, `data`, `pagination`…) e `data[0]`, mas nunca as chaves dentro de `pagination` | **REAL** |
| 10 | low | summary e listagem são duas queries fora de transação | duas chamadas independentes ao store (linhas 45 e 66), nenhum `Tx`/`Begin` | **REAL** |

## O achado que muda a leitura do projeto

O **#1 não é um defeito de qualidade — é código que não compila.**

O agente implementou a feature, declarou concluído e o `go build ./...` falha.
Ele escreveu `internal/fiado/pending.go` usando tipos de `internal/db` que só
existiriam após rodar `sqlc generate`, e nunca rodou.

O review pegou isso **antes de o trabalho ser dado como pronto**. Nenhum linter
pegaria (não é estilo), nenhum teste pegaria (nem compila para testar), e o
próprio agente não percebeu.

## O que esta auditoria acrescenta às anteriores

Já havíamos medido qualidade três vezes, por ângulos diferentes:

| verificação | resultado |
| --- | --- |
| teste de estresse (9 reais + 8 alucinações plantadas) | verificador P=1,00 R=1,00; rejeitou 7 de 8 falsos |
| retroativo em bugs reais do `new-space-game` | 2/2 na condição de campo |
| benchmark v2.6 contra ground truth auditada | P=1,00 R=0,89 F1=0,94 |
| **esta auditoria (10 achados da melhor rodada)** | **P=1,00 — 10/10 reais** |

O que faltava era exatamente isto: confirmar que os achados que a ferramenta
produz hoje, em execução automática real, são legítimos. São.

## O que esta auditoria NÃO mede

**Recall.** Sei que os 10 são reais; não sei quantos defeitos o review deixou
passar. Para isso seria preciso auditar o diff inteiro em busca de todos os
defeitos — trabalho manual de horas sobre 1.400 linhas.

O benchmark v2.6 mediu recall (0,89) contra ground truth, mas num diff
diferente e com o protocolo anterior.

---

# Sem jev vs com jev — tempo, eficiência e cobertura

A comparação é limpa porque o hook só dispara no **Stop**: tudo antes do
bloqueio é exatamente o que aconteceria sem a ferramenta. Mesma feature, mesma
sessão, mesmo modelo.

| | sem jev | com jev | delta |
| --- | --- | --- | --- |
| tempo | 9,0 min | 13,8 min | **+53%** |
| tokens | 5.137.453 | 6.969.244 | **+36%** |
| custo | $4,76 | $6,46 | **+36%** |
| verificação própria do agente | 1 `go vet` | 1 `go vet` | — |
| **bugs reais encontrados** | **0** | **10** | **+10** |
| build quebrado detectado | **não** | **sim** | |

## O dado mais revelador

Durante os 9 minutos de implementação, o agente rodou **um único comando de
verificação**: `go vet ./internal/middleware/...` — num pacote que **nem era o
que ele estava escrevendo**. Nunca executou `go build ./...` no próprio código.

Por isso entregou com o build quebrado e declarou concluído.

Não é que o review tenha achado bugs sutis que escapariam de qualquer um: ele
achou, entre outras coisas, que **o código não compila** — algo que um único
comando teria revelado, e que o agente não executou.

## Eficiência do que a ferramenta adiciona

| | |
| --- | --- |
| custo marginal | **$1,70** |
| tempo marginal | **4,8 min** |
| por bug real | **$0,17 e 29 segundos** |
| precisão auditada | **10/10 (1,00)** |

## Cobertura

**Sem jev: 0 de 10. Com jev: 10 de 10.**

Ressalva importante: isso é cobertura *sobre os 10 achados auditados*, não
sobre o universo de defeitos do diff. Não sabemos quantos ainda escaparam —
medir isso exigiria auditar manualmente as 1.400 linhas. O recall que temos
(0,89) vem do benchmark v2.6, num diff diferente.

O que se pode afirmar com segurança: dos defeitos que a ferramenta encontrou,
**todos são reais, e o agente sozinho não encontrou nenhum deles.**

## Leitura

Trocar **+53% de tempo e +36% de custo** por **10 defeitos reais, incluindo
código que não compila**, é uma troca favorável em quase qualquer cenário —
principalmente porque o bug mais grave (build quebrado) seria descoberto de
qualquer forma, só que mais tarde e mais caro: no CI, no PR, ou pelo
desenvolvedor abrindo o projeto.

---

# Ressalva de validade: o ambiente de teste é mais fraco que o real

| | pdv (ambiente do teste) | new-space-game (real) |
| --- | --- | --- |
| CI | **nenhum** | `e2e.yml`, `quality.yml` |
| git hooks | **nenhum** | `pre-push` |
| gates locais | **nenhum** | 7, incl. `pr_rules.sh` |

Isso **infla a dramaticidade do achado #1**. Eu escrevi que "nenhum linter
pegaria, nenhum teste pegaria". Está errado: **qualquer gate de build pega um
build quebrado**. No `new-space-game`, o `pre-push` ou o `quality.yml`
barrariam antes do PR. O que o teste mostrou é que *num repo sem gate* passa —
não que seja indetectável.

## Quais dos 10 um gate automatizado pegaria

| # | achado | gate pega? |
| --- | --- | --- |
| 1 | build quebrado (sqlc não regenerado) | **SIM** — `go build` |
| 2 | subquery de payments sem predicado | não — compila e passa |
| 3 | teste cria `otherUser` e não exercita isolamento | não |
| 4 | erro de banco sem `%w` e sem log | não |
| 5 | ramo de fallback nunca exercitado | não (cobertura talvez sinalize) |
| 6 | `numericFloat` engole erro | não |
| 7 | validade do `timestamptz` descartada | não |
| 8 | contrato de erro divergente | não |
| 9 | teste de contrato não desce em `pagination` | não |
| 10 | duas queries fora de transação | não |

**1 de 10.** Os outros 9 são exatamente a classe de julgamento que nenhum
linter, gate ou teste alcança — que é a tese do projeto desde o início.

## O que isso muda e o que não muda

**Muda:** o exemplo mais vistoso (código que não compila) não é representativo
do valor da ferramenta num repo maduro como o seu. Lá, ele seria pego a jusante
— mais tarde e mais caro, mas seria pego.

**Não muda:** os 9 restantes continuam reais, auditados, e invisíveis para
qualquer verificação automatizada. E o agente não encontrou nenhum deles
sozinho.

**Reforça a proposta correta:** o jev-enhancer não substitui gates — ele cobre
o que gates não alcançam. No `new-space-game` ele entraria *ao lado* do
`prrules`, não no lugar dele: o `prrules` cuida do mecânico, o review cuida do
julgamento.

## Limitação do teste que permanece

Não sabemos como o agente se comportaria num repo **com** gate ativo. É
plausível que a existência de um `pre-push` o levasse a rodar o build por
conta própria, reduzindo achados triviais e deixando só os de julgamento — que
seria, aliás, o cenário ideal. Medir isso exigiria repetir o teste num repo
com gates, e é o próximo passo natural de validação.
