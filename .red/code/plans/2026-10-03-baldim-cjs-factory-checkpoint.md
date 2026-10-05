# Baldim: CommonJS, factories de configuração e o caminho restante até S3

Em 2026-10-03, duas falhas gerais do frontend foram corrigidas e um erro de inicialização do backend Rust foi encontrado e corrigido por teste diferencial. O consumidor S3 original passou de sete para seis diagnósticos de build; ainda não produz binário. A remoção do bloqueio `_config_0` permitiu enxergar recusas antes escondidas no AWS SDK: o build isolado passou a relatar 1.080 recusas, incluindo 321 cascatas SC2004. Esses números não representam tarefas independentes, percentual de compatibilidade ou conclusão do Baldim.

## O que mudou e por quê

### Exportar uma função CommonJS não é chamá-la

O `pino-std-serializers` original faz `module.exports = errSerializer` antes dos requires que alimentam o corpo dessa função. A análise conservadora tratava esse armazenamento como possível execução do corpo e emitia SC1013 para uma leitura antecipada inexistente. A atribuição de uma função a module.exports é uma forma normal de exportação CommonJS; a inicialização e as regras de ciclos continuam sendo obrigações separadas. A referência normativa usada foi a [documentação oficial de módulos do Node 24.15.0](https://nodejs.org/download/release/v24.15.0/docs/api/modules.html).

A nova exceção de prefixo aceita somente uma atribuição simples `module.exports = identificador` em arquivo CommonJS, quando o símbolo identifica uma declaração de função com corpo no mesmo arquivo. Arrows, funções inline, aliases arbitrários e objetos exportados não ganharam essa exceção. Se qualquer outra instrução do prefixo puder executar código, volta a valer a análise conservadora anterior inteira. A análise de ciclos continua independente; um ciclo que chama o export antes do require terminar permanece recusado por SC1016.

O reconhecimento e a análise TDZ foram extraídos para `packages/compiler/src/frontend/require-tdz.ts`. O export público `isRequireStatement` de program.ts foi preservado. O scanner mantém identidade de símbolos, caminhada iterativa, trabalho transitivo sobre funções/classes e prefetch em lote; não houve substituição por comparação textual de nomes ou retirada das proteções existentes.

O probe de admissão do pino agora classifica `pino-std-serializers` como static. Isso prova a remoção da recusa de preflight desse pacote, não execução nativa qualificada do pino inteiro. O pino completo continua fora do caminho estático por outras dependências.

### Factories JavaScript com parâmetros precisam de armazenamento global

O erro reportado no AWS era uma cascata em `super(_config_0)`. A causa anterior era a referência sem lowering a `getRuntimeConfig`, uma arrow de escopo de módulo. Uma reprodução sem npm demonstrou que substituir a arrow por declaração de função remove o erro, enquanto trocar o parâmetro rest do construtor por parâmetro comum não resolve. Também falhava sem herança: o problema era o armazenamento da função, não uma limitação exclusiva de super ou do AWS.

O frontend já reservava um global para uma factory JS const sem argumentos cuja assinatura inferida não mapeia, mas cujo ABI nativo retorna dyn. Esse mecanismo agora aceita também parâmetros simples não anotados e function expressions, incluindo inicializadores parentetizados. O helper `js-factory-global.ts` deriva a assinatura pela mesma lambdaSignature usada para criar a closure. Não reordena a coleta geral de classes/globals, não inventa tipos npm e não converte um retorno dyn em cópia estrutural de record.

A extensão mantém fora desse caminho bindings mutáveis, assinaturas TS anotadas/genéricas, parâmetros default/rest/desestruturados, funções async/generator e retornos fora da família dyn. Esses casos seguem suas implementações e recusas anteriores. A monomorfização npm existente continua tendo precedência quando qualifica; não foi desligada para contornar o erro.

### Antes da inicialização, ReferenceError capturável, não panic Rust

A auditoria de borda chamou um construtor que usa a factory antes de sua declaração. O Node imprime um ReferenceError capturável e continua depois da declaração; o Rust inicialmente abortava com `scriptc: uninitialized global`. A regressão diferencial permanente ficou vermelha antes da correção.

O backend Rust agora verifica a ausência de uma função global imutável e usa o mecanismo existente `runtime::throw_reference_error` com a mensagem `Cannot access 'factory' before initialization`. Não foi adicionado unsafe nem engine para representar o erro. O caminho de globals mutáveis e os checks de outras categorias de armazenamento não foram ampliados nessa correção. O teste cobre captura do erro, stderr vazio, status zero e uso posterior bem-sucedido da mesma factory.

## Evidência permanente e validação final

- Corpus 3415: export CommonJS seguido por dois requires, chamada numérica/string e typeof do export, com stdout exato contra Node em dev/release.
- Corpus 3416: factory com parâmetro antes de super, rest sem argumento, argumento extra com efeito, fallback, function expression com dois parâmetros, ordem dos efeitos, ausência de aliasing com o objeto externo e preservação da identidade do objeto aninhado/base-config.
- Corpus 3417: chamada antecipada com ReferenceError e mensagem Node, seguida de chamada válida após inicialização, em dev/release.
- Dez testes de `require-tdz.test.ts`: caso positivo e recusas para chamadas diretas, export invocado, chamada pelo export, callback síncrono, alias, self-require, setter, arrow e ciclo de inicialização.
- Treze testes de `js-factory-global.test.ts`: quatro formas positivas e nove limites de qualificação. Dois testes de `values.test.ts` verificam o check de globals de função imutáveis e a preservação do caminho mutável, sem mutar o IR recebido.
- Node 26.10.0, alvo node26: bateria final de oito arquivos, 45 testes verdes, 93,69 segundos de runner. Node 24.15.0, alvo node24: os mesmos 45 testes verdes, 91,73 segundos. Não somar as execuções intermediárias repetidas a essa contagem.
- Os quatro testes Rust já existentes de factories recursivas/capturas e rest JS/tupla TS também passaram em cada Node. Os testes LLVM desses dois arquivos foram filtrados nessa execução focada; isso não qualifica LLVM para a nova extensão.
- Todos os seis testes nativos novos exigem engine none, externalFfi false, nenhuma runtime fence e stdout/stderr/status/sinal iguais ao Node; os binários são executados com `SCRIPTC_RUST_HEAP_AUDIT=1`.
- Build recursivo do workspace, ESLint dos helpers/testes/backend tocados, parse do YAML do CI, `pnpm node-compat:check` e `git diff --check` passaram. O lint dos dois arquivos legados maiores terminou sem erros, com 25 warnings de non-null assertion. O build expõe 77 warnings upstream do zlib-rs vendorizado já existente.

O workflow existente inclui esses arquivos nas lanes Node 26 e Node 24. CI remoto não foi executado. O pin Node 26 do projeto continua 26.8.1, mas a instalação local disponível é 26.10.0: os resultados locais não substituem a qualificação exata do pin. Node 24.15.0 foi executado exatamente. Nenhum manifesto de compatibilidade ou artefato gerado recebeu uma nova alegação de suporte nesta etapa.

Os gates completos plain e SAN foram tentados novamente após a última alteração de produção, com um worker e bail. Ambos pararam no teste `new nested runtime headers invalidate complete and output-local artifacts`, após quatro aprovações, em `spawnSync /tmp/scriptc-runtime-shadow-.../project/first EPERM`. Isso não é uma aprovação dos gates completos. Uma tentativa extra do arquivo emit-rust inteiro foi interrompida com exit 130 depois de `context canceled`; não há aprovação atribuída a essa tentativa. Não foram desativados comparadores, sanitizers ou testes para obter verde.

O limitador cgroup foi tentado e falhou ao conectar ao user bus com Operation not permitted. Workers e jobs ficaram limitados a um e o heap Node a 1536 MiB; esses limites não equivalem ao teto rígido de RAM do cgroup. Nenhum processo alheio foi encerrado. A autorização anterior do mantenedor para desenvolvimento local sem fetch/reconciliação, enquanto `.git/FETCH_HEAD` estiver somente leitura, permanece o limite desta etapa. Não houve commit/push ou sobrescrita do WIP concorrente; shipping depende dos gates e da reconciliação.

## Retestes das fontes npm originais

O consumidor `s3-client.ts` continua usando o adapter original, credenciais fictícias e sem enviar RPC. `taskExecutor: false` e `useReckerHandler: false` não eliminam os imports estáticos das dependências; não foram removidos imports ou alterados arquivos npm para melhorar o resultado. As fontes e seus SHA-256 constam nos reports.

| Probe | Resultado | Tempo | RSS máximo | Evidência local |
| --- | --- | --- | --- | --- |
| S3 antes da etapa | Build recusado, 7 diagnósticos | 93.061 ms | 665788 KiB | `results/s3-client-level6-baseline-20261003/probe.json` |
| S3 após CommonJS, antes da factory | Analyze recusado, mesmos 7 diagnósticos | 91.921 ms | 674120 KiB | `results/s3-client-cjs-prefix-20261003/probe.json` |
| AWS isolado antes da factory | Analyze recusado, SC2004 em `_config_0` | 45.341 ms | 575192 KiB | `results/aws-config-primary-20261003/probe.json` |
| AWS isolado após a factory | Build recusado, 1.080 SC3003 de fences | 37.663 ms | 561388 KiB | `results/aws-factory-global-20261003/probe.json` |
| S3 após a factory | Build recusado, 6 diagnósticos | 87.865 ms | 711064 KiB | `results/s3-client-factory-global-20261003/probe.json` |

O prefixo comum dos reports é `.red/tmp/baldim-rust-20261001-nDbseO/`. Analyze não foi rotulado como build. A correção posterior do check TDZ no emitter não muda esses diagnósticos do frontend; os testes nativos finais já exercitam esse check. Não existe binário S3 produzido ou CRUD qualificado. Redwall e daemon/plugins redskilled não foram reconstruídos nesta etapa.

Os seis diagnósticos do consumidor são quatro SC2013 de imports pino/recker, um SC2011 do agregado unknown que o consumidor imprime e um SC1090 da chamada `client.destroy`. O `_config_0` não aparece mais. Esses seis erros não enumeram todos os problemas do código transitivo: o probe AWS isolado demonstra essa diferença.

## O que ainda falta: separar causas de cascatas

O build AWS isolado, com `--no-engine`, reporta recusas SC3003 que transportam os códigos originais das fences. A contagem abaixo é de ocorrências no programa, não de APIs independentes ou prioridades por frequência.

| Família original | Ocorrências | Leitura correta |
| --- | --- | --- |
| SC2004 | 321 | Cascatas; corrigir a declaração causadora, não cada uso |
| SC1090 | 404 | Várias famílias JS: classes computadas, expressões de atribuição, funções como valores, indexing, delete, instanceof e outras |
| SC2020 | 127 | Superfícies standard/Node sem lowering para a forma exata encontrada |
| SC2003 | 82 | Representação/retag de unions, incluindo tabelas geradas S3 |
| SC2011 | 37 | Resíduos any/unknown/unions que ainda caem na recusa sem engine |
| SC1100 | 29 | Optional chaining sobre unknown |
| Demais códigos | 80 | Desestruturação, for-in, parâmetros, coerções, imports e outras recusas |

Entre as mensagens repetidas há 113 de extends computado, 25 de atribuição a propriedade como expressão, 21 de redeclaração de campo herdado em tipo diferente e 16 de for-in sobre any. Uma única implementação por família pode remover várias ocorrências e suas cascatas. Nem a contagem alta prova que todas são atingidas pelo construtor mínimo, nem a ausência de um erro no resumo externo prova suporte.

O analyze isolado também chegou a SC9001 de IR incompleto/ABI inconsistente em paths que contêm fences. O build com no-engine recusa essas fences antes de gerar binário. Esses SC9001 são uma dívida de diagnóstico/análise, não devem ser anunciados como código nativo funcional e não justificam retirar a validação de IR. O caminho ainda recusado precisa ser minimizado antes de alterar a representação das funções.

## Sequência proposta para fechar o Baldim sem atalhos

### 1. Expressões JavaScript de inicialização do Smithy

O próximo slice proposto é a atribuição de propriedades como expressão, encontrada no enum gerado de `@smithy/types` e em `getSmithyContext`. Reduzir esses trechos originais a corpus sem npm, implementar avaliação única e na ordem correta de receiver/chave/RHS, preservar o valor da expressão e os efeitos de setters, e testar chave string/symbol e erros importantes. Manter recusa nomeada para formas não implementadas. Depois reexecutar o AWS isolado e medir a família e suas cascatas, não exigir que o SDK inteiro fique verde por causa desse slice.

### 2. Classes produzidas por factories e closures reais

Reduzir o `extends command(...)` dos comandos S3 e os factories de classe Smithy. Resolver a identidade da classe, a instância especializada, construtor, campos e métodos herdados sem assumir que uma expressão de extends é uma declaração nominal simples. Em paralelo lógico, auditar defaults/rest quando funções se tornam valores e os ABIs de factories/retornos inferidos: uma closure criada mas não chamada ainda precisa de uma representação honesta. O critério é corpus Node/native com subclasses, dispatch, identidade, efeitos e erros; nenhum cast no consumidor npm serve como correção geral.

### 3. Objetos dinâmicos nativos, unions e bytes das tabelas geradas

Tratar coerentemente for-in, optional chaining, delete, computed keys e instanceof no checked-dynamic Rust. Reduzir as tabelas S3 que misturam números, records, arrays e callbacks antes de relaxar o retag de unions; preservar ordem das chaves, identidade e validação de saída tipada. Os checksums Smithy também usam typed arrays e operações numéricas ainda recusadas. Implementar formas precisas com corpus, em vez de mapear todo any para um tipo nominal fictício ou ocultar fences.

### 4. Admissão original de pino e recker

Pino ainda encontra dependências sem declaração própria (`atomic-sleep`, `on-exit-leak-free`, `quick-format-unescaped`), sonic-boom cascata e thread-stream com destructuring de require JSON. Investigar admissão/transitive typing e require JSON mantendo o conteúdo e semântica Node dos metadados externos; não criar declaração permissiva falsa para fazer o pacote parecer estático. A aceitação do serializer corrigida nesta etapa é só um ponto desse grafo. Os testes devem cobrir logger, serializer, escrita/flush e erros reais em execução local controlada.

O recker original importa default `node:dns/promises` em `dist/utils/timing-connector.js`, hoje SC1010. Faz lookup IPv4 e, em caso de erro, tenta IPv6. O runtime DNS atual só implementa callback IPv4; portanto um wrapper que apenas promete esse callback não fecha a forma do recker. Verificar o backlog/basis, as docs oficiais do pin e o código, definir os overloads e erros de lookup, implementar resolução IPv4/IPv6 e promise/default import, e adicionar diferencial executado sem depender de um DNS remoto. Depois auditar as formas exatas de net/tls, perf_hooks, HTTP/HTTP2 e stream efetivamente usadas. O smoke de `expandHTTP2Options` não equivale a qualificação do recker completo.

### 5. Contrato mínimo do adapter, depois protocolo S3

Quando as dependências originais estiverem admitidas e os paths necessários sem fences, retomar a criação do adapter e destroy, resolvendo o agregado unknown pelo lowering geral em vez de remover os campos impressos. Exigir binário Rust sem engine/FFI e comparação da inicialização/destruição contra Node. Só depois usar um servidor S3 local controlado ou emulador para put/get/head/list/delete, metadata, paginação, assinatura, retries, timeout/cancelamento, streams e erros. Não usar credenciais reais ou bucket remoto como primeira prova; operações externas/materialmente destrutivas exigem escopo explícito.

### 6. Qualificação e consumidores seguintes

Executar os dois gates completos num ambiente em que os contratos de execução/rede tenham permissão, qualificar o pin Node 26.8.1 e Node 24.15.0, revisar os diffs/manifestos e reconciliar origin/main antes de shipping. Depois repetir os contratos em redwall e nos plugins/daemon redskilled com suas fontes originais. Não declarar esses projetos compatíveis por os corpus mínimos do compilador passarem.

## Por que uma biblioteca Rust 1:1 do Node ajuda, mas não fecha tudo

Uma implementação Rust precompilada das APIs realmente usadas de Node reduz o trabalho de fs, crypto, process, DNS, transporte e streams, desde que implemente overloads, callbacks/promises, eventos, identidade, erros e ciclo de vida, não só nomes de interfaces. Esta etapa mostrou separadamente bugs de análise CommonJS, armazenamento de closures e TDZ, que nenhuma assinatura de fs/crypto resolve. O objetivo continua TS/JS para código Rust nativo com semântica comprovada, Node 26 como foco e 24 como compatibilidade, sem nightly ou engine para esconder as lacunas.

A disciplina de contexto e diagnóstico orientou a redução do programa, os testes red-green e a auditoria de inicialização antes do checkpoint. O registro local separa resultado de build, evidência comportamental, refusals e condições de shipping; não muda a promessa pública de compatibilidade.
