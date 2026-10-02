# Decisões de Arquitetura

Este documento registra as principais decisões técnicas do desafio e os motivos por trás delas.

O objetivo não é repetir o README, mas explicar as escolhas que afetam correção financeira, concorrência, idempotência e mensageria.

## Objetivos arquiteturais

A solução foi orientada pelas seguintes garantias:

- valores monetários não podem sofrer erro de ponto flutuante;
- uma operação não pode produzir efeito financeiro duplicado;
- concorrência entre instâncias não pode gerar saldo incorreto;
- Wallet, transação, Ledger, Inbox e Outbox devem respeitar atomicidade;
- falhas de mensageria não podem causar perda silenciosa de eventos;
- redelivery deve ser seguro;
- o Ledger deve ser auditável e imutável;
- REFUND e ROLLBACK devem ser seguros mesmo quando eventos chegam fora de ordem.

## Visão geral

A aplicação é dividida em domínio, casos de uso, infraestrutura e interfaces.

O domínio não conhece NestJS, MikroORM ou AWS. A infraestrutura adapta PostgreSQL e SQS às necessidades da aplicação.

O PostgreSQL é o ponto de coordenação entre instâncias. Não há mutex em memória ou lock dependente de um único processo.
## 1. Dinheiro como valor decimal explícito

Valores monetários são representados pelo value object `Money`, baseado em `decimal.js`.

Decisão: nunca usar `number`/float como fonte de verdade para saldo ou valor financeiro.

Motivo: operações binárias de ponto flutuante podem introduzir erros de arredondamento. O domínio também valida formato, moeda e precisão antes de qualquer movimentação.

## 2. Transação SQL como unidade de consistência

Cada operação financeira relevante persiste suas alterações dentro de uma única transação PostgreSQL.

Quando aplicável, a mesma transação confirma:

- saldo da Wallet;
- `WagerTransaction`;
- entrada no Ledger;
- Inbox;
- Outbox.

Decisão: evitar confirmações parciais entre esses artefatos.

Se qualquer parte falhar, o PostgreSQL faz rollback da unidade inteira.

## 3. Concorrência por optimistic locking + retry limitado

A Wallet possui coluna de versão gerenciada pelo optimistic locking do MikroORM.

Duas operações podem ler o mesmo saldo, mas somente a primeira atualização com a versão esperada consegue efetivar a mudança. A concorrente recebe conflito e reexecuta a operação em uma nova transação e com um novo `EntityManager`.

O retry é limitado e usa backoff. Não existe loop infinito.
Essa escolha foi preferida a um lock pessimista permanente na Wallet porque mantém o caminho comum simples e delega a coordenação ao banco apenas quando realmente existe disputa.

Importante: no retry a operação inteira é recalculada a partir do estado atualizado. O sistema não tenta apenas salvar novamente o mesmo objeto antigo.

## 4. Idempotência persistente

A idempotência não depende de cache ou memória local.

Cada transação possui `idempotencyKey` e um hash canônico do payload. A combinação permite distinguir dois casos:

- mesma chave + mesmo payload: replay legítimo, devolvendo o resultado originalmente persistido;
- mesma chave + payload diferente: conflito de idempotência.

Também existe unicidade para a identidade externa da transação no provedor.

Decisão: restrições do PostgreSQL são a barreira final contra corridas em que duas instâncias verificam a inexistência do registro quase ao mesmo tempo.

Somente constraints conhecidas e relacionadas à concorrência entram na política de retry. Violações de unicidade inesperadas não são escondidas.

## 5. Prova multi-instância

Além dos testes com EntityManagers independentes, existe `bun run test:distributed`.

Esse teste cria um banco temporário, sobe dois processos Nest separados e dispara operações concorrentes contra a mesma Wallet.

A prova esperada é: uma BET processada, uma rejeitada por saldo insuficiente, saldo final correto e exatamente um débito no Ledger.
## 6. Inbox/Outbox e entrega at-least-once

A solução assume que mensageria distribuída pode entregar a mesma mensagem mais de uma vez.

Por isso, a estratégia não tenta prometer exactly-once. Ela combina:

- Outbox para não perder eventos produzidos junto com a transação financeira;
- Inbox para neutralizar redelivery no consumo;
- IDs estáveis de mensagem independentes do `MessageId` gerado pelo SQS.

Decisão: preferir a possibilidade controlada de duplicação à possibilidade de perda.

Se o SQS aceitar um evento e o processo cair antes de gravar `publishedAt`, o Outbox poderá publicá-lo novamente. O consumidor deve tratar essa duplicata de forma idempotente.

## 7. SQS, redelivery e DLQ

O consumer só remove a mensagem da fila depois que o processamento termina com sucesso e o estado foi persistido.

Se o processamento falhar, não há ACK. Após o visibility timeout, a mensagem volta a ficar disponível.

Falhas repetidas são tratadas pela `RedrivePolicy` do próprio SQS, que move a mensagem para uma DLQ.

Decisão: retry temporário e isolamento de mensagens problemáticas ficam separados. O consumer não envia manualmente para a DLQ.
## 8. Ledger imutável

O Ledger não é apenas tratado como append-only pela aplicação. O PostgreSQL também bloqueia `UPDATE`, `DELETE` e `TRUNCATE` por trigger.

Decisão: uma proteção de auditoria crítica não deve depender apenas de disciplina no código da aplicação.

As migrations do trigger foram validadas em ciclo `up → down → up`, verificando que a imutabilidade continua ativa após aplicar, reverter e reaplicar a migration.

## 9. REFUND e ROLLBACK

Reversões precisam apontar para uma transação externa de referência.

O processamento valida tipo, provider, player, wallet, round, moeda, valor e estado da referência antes de movimentar saldo.

`REFUND` devolve uma BET processada. `ROLLBACK` aplica o efeito inverso da transação referenciada quando a combinação é válida.

Para impedir dupla reversão concorrente, a transação referenciada é bloqueada durante a decisão e existe uma unique constraint parcial para reversões já `PROCESSED` do mesmo tipo.

Essa combinação protege tanto a regra de negócio quanto a corrida entre instâncias.
## 10. Referências fora de ordem

Uma reversão pode chegar antes da transação original.

Nesse caso ela é persistida como `PENDING_REFERENCE`, com contador de tentativas e `referenceNextAttemptAt`.

Um resolver em background procura apenas pendências vencidas. Se a referência apareceu, conclui a reversão. Se ainda estiver ausente, agenda nova tentativa com backoff. Após o limite, encerra como `REJECTED / REFERENCE_NOT_FOUND`.

Decisão: depois que o estado pendente está seguro no PostgreSQL, a recuperação não depende da mensagem original permanecer na fila nem da memória de um processo.

## 11. Uso de `FOR UPDATE SKIP LOCKED`

`SKIP LOCKED` é usado para selecionar trabalho persistido que pode ser executado por várias instâncias, como Outbox e referências pendentes.

Se uma instância já bloqueou uma linha, outra pula essa linha e procura outro trabalho em vez de esperar ou processar o mesmo item.

Isso não substitui o optimistic locking da Wallet. São mecanismos com responsabilidades diferentes:

- optimistic locking protege atualização concorrente do saldo;
- `SKIP LOCKED` distribui itens de trabalho persistidos entre workers.
## 12. Workers separados da regra de negócio

Os workers Nest apenas executam loops de background e participam do lifecycle da aplicação.

Eles não contêm regra financeira. Chamam casos de uso já testados e podem ser habilitados por variável de ambiente.

Isso mantém separadas três responsabilidades:

- regra de negócio;
- coordenação transacional;
- agendamento contínuo de trabalho.

Os workers ficam desligados por padrão para que API, unit tests e E2E possam subir sem exigir SQS ou processamento em background.

## 13. Infraestrutura SQS local

LocalStack é usado para testar o protocolo SQS real sem depender de uma conta AWS.

O provisionamento das filas é separado da inicialização da aplicação. O script `bun run sqs:provision` cria ou reutiliza as filas locais e configura a política de DLQ.

A fila de entrada de wagering é FIFO. A fila de eventos de Outbox é Standard porque o contrato atual não exige ordenação dos eventos de saída.

Se futuramente houver exigência de ordem por Wallet ou agregado, a fila de saída pode migrar para FIFO usando `aggregateId` como `MessageGroupId`.
## 14. Trade-offs conscientes

### Publicação do Outbox dentro do lock da linha

O dispatcher mantém a linha do Outbox bloqueada enquanto publica no SQS. Isso simplifica a coordenação entre múltiplas instâncias e evita publicação concorrente da mesma linha durante uma execução normal.

O custo é manter uma transação aberta durante uma chamada de rede. Em um sistema de volume maior, uma alternativa seria implementar lease/claim (`claimedBy`, `lockedUntil`) e publicar fora da transação.

Para o escopo do desafio foi escolhida a solução menor e mais fácil de provar corretamente.

### At-least-once, não exactly-once

A solução não afirma exactly-once delivery. Uma queda depois do envio ao SQS e antes do commit de `publishedAt` pode produzir nova publicação.

Essa duplicação é esperada e deve ser neutralizada por idempotência/Inbox no consumidor.

### Visibility timeout

O processamento foi desenhado para operações curtas. Não existe extensão dinâmica do visibility timeout durante uma execução longa.

Se o processamento ultrapassar esse período, pode ocorrer redelivery; a proteção contra efeito duplicado continua sendo a idempotência persistente.
## 15. Soluções evitadas de propósito

Algumas alternativas foram deliberadamente evitadas:

- mutex em memória para saldo ou idempotência;
- locks distribuídos em Redis sem necessidade;
- uso de `number` para valores monetários;
- mocks como única prova de PostgreSQL ou SQS;
- ACK da mensagem antes do commit do processamento;
- retry indiscriminado de qualquer erro de banco;
- promessa de exactly-once sem mecanismo que a sustente.

A intenção foi manter a solução pequena, verificável e baseada em garantias do PostgreSQL e do SQS.

## 16. Evidências de correção

As decisões acima são exercitadas por testes contra infraestrutura real local:

- PostgreSQL para concorrência, atomicidade, constraints e Ledger;
- LocalStack/SQS para publicação, consumo, redelivery e DLQ;
- duas instâncias Nest reais no teste distribuído;
- migrations verificadas em ciclo `up → down → up`;
- cenários de REFUND/ROLLBACK, duplicidade e referência fora de ordem.

O objetivo dos testes não é apenas aumentar cobertura, mas transformar as principais afirmações arquiteturais em comportamentos reproduzíveis.
