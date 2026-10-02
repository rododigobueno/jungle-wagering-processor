# Jungle Wagering Processor

Implementação de um processador de transações de wagering com foco em **correção financeira, concorrência, idempotência, mensageria e rastreabilidade**.

O sistema foi construído em TypeScript/NestJS, com PostgreSQL como fonte de verdade e AWS SQS (via LocalStack no ambiente local) para processamento assíncrono.

## Principais garantias

- valores monetários tratados com precisão decimal, sem uso de `float` para dinheiro;
- saldo da wallet nunca fica negativo;
- Ledger financeiro imutável no PostgreSQL;
- idempotência persistente para chamadas HTTP e mensagens SQS;
- atualização de saldo, transação, Ledger, Inbox e Outbox de forma atômica quando aplicável;
- concorrência segura entre múltiplas instâncias da aplicação;
- retry limitado para conflitos concorrentes;
- redelivery seguro de mensagens e DLQ para falhas persistentes;
- suporte a `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`;
- resolução posterior de reversões recebidas antes da transação referenciada.

## Stack

- Bun
- TypeScript em modo estrito
- NestJS
- PostgreSQL 16
- MikroORM 7
- `decimal.js`
- AWS SQS SDK
- LocalStack
- Vitest

## Arquitetura resumida

O projeto separa domínio, aplicação, infraestrutura e interfaces HTTP. A regra financeira não depende diretamente de NestJS, SQS ou detalhes de persistência.

Fluxo simplificado:

```text
HTTP / SQS
   ↓
Use cases
   ↓
Domínio financeiro
   ↓
PostgreSQL
   ├─ Wallet
   ├─ WagerTransaction
   ├─ Ledger
   ├─ Inbox
   └─ Outbox
        ↓
      SQS
```

O PostgreSQL é o ponto de coordenação entre instâncias. Não há mutex em memória para proteger saldo ou reversões.

## Regras das transações

| Tipo | Efeito principal |
| --- | --- |
| `BET` | debita saldo; rejeita se não houver saldo suficiente |
| `WIN` | credita saldo |
| `LOSS` | registra a transação sem alterar saldo |
| `REFUND` | reverte uma `BET` processada, creditando o valor |
| `ROLLBACK` | aplica o efeito inverso de uma transação referenciada válida |

`REFUND` e `ROLLBACK` exigem referência externa. Valor, moeda, wallet, player, provider e rodada são validados contra a transação original.

## Concorrência e idempotência

A wallet usa **optimistic locking** com versionamento no PostgreSQL. Se duas operações leem o mesmo saldo ao mesmo tempo, apenas uma consegue persistir a versão antiga; a outra recebe conflito e refaz a operação a partir do estado mais recente.

Os retries são limitados e usam um novo `EntityManager`/transação a cada tentativa. Isso evita reutilizar estado obsoleto da identity map.

A idempotência é persistente:

- HTTP usa `Idempotency-Key` + hash canônico do payload;
- mesma chave + mesmo payload retorna o resultado original;
- mesma chave + payload diferente retorna conflito;
- no SQS, `Inbox` deduplica por `consumerName + messageId`;
- duplicatas concorrentes também são protegidas por constraints do PostgreSQL.

## Inbox, Outbox e SQS

O processamento assíncrono usa o padrão **Inbox/Outbox**.

### Entrada

A mensagem SQS só recebe ACK (`DeleteMessage`) depois que o processamento financeiro foi persistido com sucesso. Se houver falha, a mensagem reaparece após o visibility timeout.

Uma `RedrivePolicy` nativa do SQS envia mensagens com falhas repetidas para uma DLQ FIFO.

### Saída

Eventos de domínio são gravados no `Outbox` dentro da mesma transação SQL da operação financeira. Um worker posterior publica esses eventos no SQS e marca `publishedAt`.

A entrega é tratada como **at-least-once**: uma mensagem pode ser publicada novamente se o processo cair após o envio ao SQS e antes do commit no banco. Por isso os consumidores devem ser idempotentes.

## Ledger imutável

Cada movimentação financeira gera uma entrada de Ledger com:

- direção (`CREDIT` ou `DEBIT`);
- valor e moeda;
- saldo anterior;
- saldo posterior;
- transação associada.

Além da regra na aplicação, o PostgreSQL possui triggers que bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` da tabela de Ledger. A proteção foi validada inclusive durante ciclos de migration `up → down → up`.

## Referências fora de ordem

Uma reversão pode chegar antes da transação original.

Nesse caso ela é persistida como `PENDING_REFERENCE`, sem movimentar saldo. O banco armazena contador de tentativas e próxima data de resolução.

Um worker em background:

1. busca apenas pendências vencidas;
2. usa `FOR UPDATE SKIP LOCKED`, permitindo múltiplas instâncias;
3. tenta resolver novamente a referência;
4. aplica backoff exponencial quando ela continua ausente;
5. após o limite configurado, finaliza como `REJECTED / REFERENCE_NOT_FOUND`.

Assim a mensagem original pode ser ACKada com segurança: a pendência já está persistida no PostgreSQL e não depende da memória do processo.

## Como executar localmente

### Pré-requisitos

- Bun instalado;
- Docker / Docker Compose disponíveis;
- portas `5432` e `4566` livres.

### 1. Instalar dependências

```bash
bun install
```

### 2. Subir PostgreSQL e LocalStack

```bash
docker compose up -d
```

O `docker-compose.yml` sobe:

- PostgreSQL 16 em `localhost:5432`;
- LocalStack Community em `localhost:4566`, com SQS habilitado.

### 3. Aplicar migrations

```bash
bunx mikro-orm migration:up
```

### 4. Provisionar as filas locais

```bash
bun run sqs:provision
```

O comando cria/reutiliza a fila FIFO de entrada, sua DLQ FIFO e a fila de eventos do Outbox, exibindo as URLs necessárias no terminal.

### 5. Configuração por ambiente

A conexão com PostgreSQL aceita as variáveis abaixo, mantendo estes defaults locais:

| Variável | Default |
| --- | --- |
| `DB_HOST` | `localhost` |
| `DB_PORT` | `5432` |
| `DB_USER` | `jungle` |
| `DB_PASSWORD` | `jungle` |
| `DB_NAME` | `jungle_wagering` |

Os workers ficam **desligados por padrão**. Para habilitar o fluxo completo com SQS, configure:

| Variável | Uso |
| --- | --- |
| `SQS_ENDPOINT_URL` | endpoint do SQS; localmente `http://localhost:4566` |
| `AWS_REGION` | região AWS; localmente `us-east-1` |
| `SQS_WAGER_CONSUMER_ENABLED=true` | habilita o consumer de transações |
| `SQS_WAGER_QUEUE_URL` | URL impressa por `bun run sqs:provision` |
| `SQS_OUTBOX_DISPATCHER_ENABLED=true` | habilita publicação do Outbox |
| `SQS_OUTBOX_QUEUE_URL` | URL da fila `wager-events` |
| `PENDING_REFERENCE_RESOLVER_ENABLED=true` | habilita o resolver de referências pendentes |

### 6. Iniciar a aplicação

```bash
bun run start:dev
```

Para validar apenas a API HTTP, não é necessário habilitar os workers.

## API HTTP

### Criar wallet

`POST /wallets`

```json
{
  "playerId": "player-123",
  "initialBalance": {
    "amount": "100.00",
    "currency": "BRL"
  }
}
```

Resposta `201`:

```json
{
  "id": "<uuid>",
  "playerId": "player-123",
  "balance": { "amount": "100.00", "currency": "BRL" },
  "version": 1
}
```

### Processar transação

`POST /wagering/transactions`

Header obrigatório:

```text
Idempotency-Key: <chave-estavel-do-request>
```

Exemplo de `BET`:

```json
{
  "providerId": "provider-a",
  "externalTransactionId": "bet-001",
  "walletId": "<uuid>",
  "playerId": "player-123",
  "roundId": "round-001",
  "gameId": "game-001",
  "kind": "BET",
  "money": {
    "amount": "25.00",
    "currency": "BRL"
  }
}
```

Resposta de sucesso de negócio:

```json
{
  "transactionId": "<uuid>",
  "status": "PROCESSED",
  "balance": { "amount": "75.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

Uma transação pode ser persistida com `status: "REJECTED"` e ainda assim retornar HTTP `201`: nesse caso a requisição foi aceita e auditada, mas a regra de negócio rejeitou o efeito financeiro, por exemplo por `INSUFFICIENT_FUNDS`.

Para `REFUND` e `ROLLBACK`, inclua também `referenceExternalTransactionId`.

## Testes e validação

Com PostgreSQL e LocalStack ativos:

```bash
# lint
bun run lint

# unitários
bun test

# integração com PostgreSQL e SQS reais
bun run test:integration

# aplicação via HTTP/Nest
bun run test:e2e
```

No checkpoint atual, a suíte possui:

- `42/42` testes unitários;
- `28/28` testes de integração;
- `1/1` teste E2E.

Os testes de integração usam PostgreSQL real e, quando aplicável, SQS real via LocalStack. Não dependem apenas de mocks para validar concorrência ou mensageria.

### Teste distribuído com duas instâncias reais

```bash
bun run test:distributed
```

Esse comando cria um banco temporário, sobe **dois processos Nest/Node independentes**, envia duas BETs concorrentes de `80.00` contra uma wallet de `100.00` e valida no PostgreSQL:

- exatamente uma BET `PROCESSED`;
- exatamente uma BET `REJECTED / INSUFFICIENT_FUNDS`;
- saldo final `20.00`;
- exatamente um débito de `80.00` no Ledger.

Ao final, as instâncias são encerradas e o banco temporário é removido.

## Decisões arquiteturais principais

- **PostgreSQL como fonte de verdade:** a correção entre múltiplas instâncias não depende de memória local.
- **`decimal.js` para dinheiro:** valores monetários entram e saem como strings decimais e não são calculados com `float`.
- **Optimistic locking na wallet:** conflitos de saldo são detectados pela versão da linha e refeitos com estado atualizado.
- **`FOR UPDATE SKIP LOCKED`:** usado onde várias instâncias disputam itens de trabalho, como Outbox e referências pendentes.
- **Inbox/Outbox transacionais:** evita separar a confirmação da mensagem do efeito persistido.
- **At-least-once em vez de exactly-once:** duplicatas são consideradas possíveis e neutralizadas por idempotência.
- **Ledger protegido também no banco:** regras críticas não dependem apenas de disciplina da aplicação.
- **Retries limitados:** nenhum conflito ou referência ausente fica em retry infinito.

O projeto procura diferenciar claramente **falha técnica** de **resultado de negócio**. Uma BET sem saldo, por exemplo, é auditada como `REJECTED`, enquanto uma falha de infraestrutura provoca rollback/retry conforme o fluxo.

## Estrutura principal

```text
src/domain          → regras e invariantes de negócio
src/application     → casos de uso e orquestração transacional
src/infrastructure  → PostgreSQL, SQS e workers
src/interfaces      → entrada HTTP
test                → integração e E2E
scripts             → provisionamento e validações reproduzíveis
```

## Processo de desenvolvimento e uso de IA

Este projeto foi desenvolvido com **uso intensivo de Inteligência Artificial** como ferramenta de pair programming, pesquisa e apoio à implementação.

A IA teve participação relevante na produção do código. Minha forma de trabalho, porém, não consiste em aceitar automaticamente o que é gerado. Procuro conduzir o processo definindo requisitos e restrições, questionando decisões importantes e transformando afirmações técnicas em algo verificável.

Minha base técnica continua em evolução, e uso IA para ampliar minha capacidade de execução e aprender durante o processo. A responsabilidade sobre as decisões e sobre o resultado entregue, no entanto, permanece comigo.

Neste desafio, isso incluiu práticas como:

- verificar a versão exata das bibliotecas antes de depender de determinado comportamento;
- reproduzir erros antes de corrigi-los;
- validar concorrência contra PostgreSQL real;
- testar SQS via LocalStack, incluindo redelivery e DLQ;
- inspecionar diretamente o estado persistido no banco;
- testar migrations em `up → down → up` antes de aplicá-las ao banco de desenvolvimento;
- rejeitar migrations geradas automaticamente quando elas ameaçavam uma garantia já existente;
- validar concorrência com dois processos Nest independentes.

A IA foi usada para acelerar pesquisa e implementação, mas **uma resposta da IA não foi tratada como prova de correção**. O critério final foi o comportamento observável do sistema, sustentado por testes e pelo estado persistido.
