# Experimento E — o Jev sustenta a qualidade num modelo barato?

Pergunta: usar a ferramenta **sem Jev num Opus 5** contra **com Jev num modelo
~10× mais barato** entrega qualidade equivalente?

**Resposta: não.** E o motivo tem uma parte estrutural, que nenhum ajuste
resolve, e uma parte empírica, que é pior do que a estrutural previa.

## O limite estrutural

`verifyFindings` é um `findings.map`. O Jev recebe a lista de achados e
devolve a mesma lista com um veredito anotado — **nunca adiciona**.

Logo: **o Jev pode elevar precisão, não pode elevar recall.** O teto de
quantos defeitos reais aparecem é fixado por quem gera. O que o modelo barato
não achar, nada recupera.

## Desenho

Arquitetura D3 idêntica nos dois, mesmo snapshot, mesmo prompt, mesmo
`known-defects.yaml` de 27 defeitos verificados à mão. Variável única: o
modelo.

Economia do desenho: `findings.json` é gravado **antes** da triagem e
`findings-verified.json` depois, então cada execução entrega o "sem Jev" e o
"com Jev" de uma vez. O braço "Opus sem Jev" já existia — é o bruto das
execuções `d3-*`. Nenhuma execução nova foi gasta com controle.

## Resultado

| | Opus 5 | Haiku 4.5 |
| --- | --- | --- |
| recall | **39,5%** | 22,2% |
| recall ponderado por severidade | **49%** | 25% |
| achou o defeito HIGH (build quebrado) | **18/18** | **0/2** |
| custo por execução | $2,17 | **$0,16** |
| custo por defeito real | $0,203 | **$0,027** |
| tempo | 292s | **86s** |

Por defeito encontrado, o Haiku é **7,5× mais barato**. A economia é real.

Mas ele **perde sistematicamente o pior defeito**. `sqlc não regenerado, o
pacote não compila` foi achado por todas as 18 execuções com Opus e por
nenhuma com Haiku. Não é variância: é a diferença entre um modelo que roda
`go build` e lê a saída e um que não chega lá.

Escalar não resolve: 2× Haiku dá 33,3% — ainda abaixo de 1× Opus (39,5%) — e
continua sem achar o `HIGH`. Mais execuções de um modelo que não olha o build
não produzem o achado do build.

## O que aconteceu quando o Jev finalmente teve trabalho

Nas 18 execuções com Opus, **zero alucinações**: o Jev nunca teve o que
filtrar. Com o Haiku, na primeira execução, apareceu a primeira alucinação
real do projeto.

O Haiku reportou como **HIGH**: *"a função `assertAppError` não está definida,
os testes não compilam"*. A definição `func assertAppError(...)` **está no
diff que o Jev recebeu**, em `pending_test.go:234`, dentro dos 45.283
caracteres de `state.diff`.

Submetido ao Jev:

```
valid  = 0.83   "é um defeito real"
contra = 0.29   "o diff NÃO contradiz a premissa"
existe = 0.75   "assertAppError APARECE DEFINIDA no diff"
```

As duas últimas se contradizem. E o 0,83 foi **a maior confiança do lote** —
os dois achados verdadeiros da mesma execução ficaram em 0,56 e 0,62. O Jev
não só deixou passar: rankeou a alucinação acima dos defeitos reais.

Reproduzível em `test/casos/jev-inconsistencia-composicional.mjs`.

### Diagnóstico

O Jev **acerta o fato e erra a composição**. Pergunta estreita e factual
("este símbolo aparece definido?") ele responde certo, 0,75. O passo de usar
esse fato para invalidar um achado que afirma o contrário, ele não dá.

Isso também refuta a leitura do teste de estresse anterior (7 de 8 alucinações
plantadas rejeitadas). Lá as alucinações eram sobre código que não existia em
lugar nenhum — *"loop de retry com off-by-one"*. Alucinação real de modelo
fraco não é assim: ela cita um símbolo que **existe**, em outro arquivo do
mesmo pacote. O teste de estresse media um caso fácil.

### Em defesa do Jev, o que ele acertou

Em `haiku45-3` ele marcou `contradicted` num achado que dizia *"Atoi may
succeed with truncation rather than error"*. Falso: `strconv.Atoi` devolve
`value out of range`. Verifiquei rodando. **Remoção correta.**

Placar com modelo barato: **1 remoção correta, 1 alucinação confirmada como o
achado mais crível.** Não é inútil; é não-confiável.

## Conclusão

Trocar Opus por Haiku + Jev **não mantém a qualidade**:

1. **Recall cai pela metade** (39,5% → 22,2%) e o Jev não pode compensar, por
   construção.
2. **A severidade cai mais que o volume** (49% → 25% ponderado): o que se
   perde é justamente o que importa.
3. **O defeito mais grave some** (18/18 → 0/2).
4. **O Jev não é rede contra alucinação de modelo fraco** — falhou no primeiro
   caso real, com a evidência na mão.

O que o experimento **não** diz é que o modelo barato é inútil. $0,027 por
defeito real é um número muito bom para uma varredura de primeira passada,
desde que ninguém confunda isso com cobertura e alguém leia os achados com
ceticismo.

## Próximo passo que os dados apontam

O diagnóstico — fato certo, composição errada — é uma hipótese testável e
barata: decompor a verificação em **perguntas atômicas derivadas do achado**
("o símbolo X existe no diff?", "a linha citada contém Y?") em vez de perguntar
"este achado é válido?". Se o Jev responde bem o estreito e mal o composto,
mover a composição para código determinístico é a correção óbvia.

Antes disso, o Jev não deve ser apresentado como camada de confiança.

## Ressalvas

- **n=2 para o Haiku no recall.** `haiku45-1` não produziu `findings.json` (o
  pipeline não completou), então entra na análise de alucinação mas não na de
  recall.
- Um repo, uma feature. O Haiku pode ir melhor em diffs menores.
- O `known-defects.yaml` foi construído majoritariamente por execuções com
  Opus, o que **favorece o Opus**: defeitos que só um modelo fraco acharia
  provavelmente não estão lá. O viés vai na direção da conclusão, então não a
  salva — mas o tamanho real da diferença pode ser menor que o medido.
