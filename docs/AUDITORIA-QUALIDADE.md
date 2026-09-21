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
