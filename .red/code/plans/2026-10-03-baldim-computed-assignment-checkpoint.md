# Baldim e atribuições computadas no compilador Rust

Em 3 de outubro de 2026, scriptc passou a compilar os padrões de atribuição computada usados pelos enums e pelo contexto do Smithy sem engine JavaScript ou FFI externa. O build do AWS SDK original caiu de 1.080 para 1.055 diagnósticos, removendo 25 ocorrências dessa família. O Baldim/S3 ainda não gera binário: seu consumidor original mantém seis diagnósticos externos, e o SDK isolado continua demonstrando lacunas transitivas que esse resumo não enumera.

Este checkpoint continua [a etapa CommonJS e factories](./2026-10-03-baldim-cjs-factory-checkpoint.md). Não altera o roadmap para nightly, não modifica fontes npm e não amplia classificações públicas de APIs Node.

## Comportamento implementado e seus limites

`lower-computed-assignment.ts` trata `receiver[key] = value` em posição de valor quando o receiver já tem representação checked-dynamic nativa, incluindo a view compartilhada de arrays nativos de elementos dinâmicos. O lowering captura receiver, chave ainda não convertida e RHS uma vez, nessa ordem. Literais de objeto à direita nascem diretamente como objetos dinâmicos; a escrita e o resultado da expressão usam o mesmo valor capturado, evitando uma segunda conversão que copiaria o contexto do Smithy.

A nova operação de IR `dyn.keySetComputed` recebe três valores dinâmicos e retorna void. Ela pertence ao conjunto de operações que podem lançar exceções, tem assinatura validada e passa pelo round-trip existente da IR. O resultado da atribuição vem do temporário do RHS, não de uma leitura posterior da propriedade. Consumidores tipados continuam fazendo suas conversões normais; o corpus TypeScript cobre um retorno number a partir dessa expressão.

O helper Rust em `dynamic-key-write.ts` adia a conversão da chave até depois do RHS. Um receiver null/undefined falha antes de converter uma chave-objeto ou invocar seus hooks. As chaves primitivas preservam a formatação e os erros exercitados pelo Node; symbol retém sua identidade em mapas nativos comuns. Dois symbols com a mesma descrição continuam sendo duas propriedades distintas. A mensagem de erro de um receiver nullish com chave symbol usa a representação descritiva do symbol, sem executar a conversão proibida de Symbol para string.

A ordem vem de [Assignment Evaluation](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-assignment-operators-runtime-semantics-evaluation), [EvaluatePropertyAccessWithExpressionKey](https://tc39.es/ecma262/multipage/ecmascript-language-expressions.html#sec-evaluate-property-access-with-expression-key) e [PutValue](https://tc39.es/ecma262/multipage/ecmascript-data-types-and-values.html#sec-putvalue). Os dois Node executados localmente são a evidência comportamental dos corpus; a especificação não substitui essa execução.

Não foi implementada a família inteira de atribuições JavaScript. Chaves-objeto sobre receivers válidos e symbol sobre arrays/exóticos mantêm recusas explícitas de execução. Records estáticos, setters, campos de classes e outras representações não admitidas por esse helper mantêm seus caminhos e limites anteriores. C e LLVM recusam a nova ABI com SC3001 em vez de um erro interno. Essa etapa não transforma nenhum desses limites em suporte presumido.

## Evidência diferencial e regressões

Os seis corpus novos são `3418-js-computed-assignment-context.mjs`, `3419-js-computed-assignment-order.mjs`, `3420-js-computed-assignment-array.mjs`, `3421-js-computed-assignment-keys.mjs`, `3422-js-computed-assignment-null-keys.mjs` e `3423-ts-unknown-computed-assignment.ts`. O primeiro reproduziu SC1090 antes da implementação, inclusive no enum reverse mapping e em `getSmithyContext`.

Os testes cobrem identidade do objeto armazenado/retornado, inicialização lazy do contexto, cadeias de atribuição, efeitos únicos de receiver/chave/RHS, mudança da variável do receiver ou da chave durante o RHS, exceções na avaliação da chave e do RHS, crescimento e truncamento de arrays, holes, chaves string/number/boolean/null/undefined/bigint/symbol e erros nullish. Cada corpus positivo roda em Rust dev e release com auditoria do heap, engine none, externalFfi false e runtimeFences vazias; stdout, stderr e status de saída são comparados byte a byte contra Node.

`js-computed-assignment.test.ts` também testa duas recusas nativas de execução, a recusa do record estático e os diagnósticos C/LLVM. `lower-computed-assignment.test.ts` verifica a captura e a reutilização do mesmo resultado na IR. `validate.test.ts` valida assinatura, resultado e efeito de exceção. Os dois novos arquivos de testes entraram nas etapas CI de foco Node 26 e compatibilidade Node 24; a sintaxe YAML foi verificada.

A rodada final de nove arquivos passou com 61 testes em cada Node: 27 testes focados da nova família e IR, mais regressões de CommonJS, factories, TDZ, valores globais Rust e refusals de módulos nativos. Node 26.10.0 foi o executável de foco disponível nesta máquina, não o pin 26.8.1; Node 24.15.0 foi a compatibilidade executada. Rust foi o toolchain stable 1.98.0. Não houve instalação ou uso de nightly.

## Reteste das fontes originais

Os probes mantêm as fontes e imports npm originais, credenciais fictícias e nenhum send/CRUD. O consumidor Baldim mantém `taskExecutor: false` e `useReckerHandler: false`, que não removem os imports estáticos de pino/recker. O prefixo das evidências é `.red/tmp/baldim-rust-20261001-nDbseO/results/`.

| Probe de build | Antes | Depois | Report final |
| --- | --- | --- | --- |
| AWS S3Client isolado | 1.080 SC3003 | 1.055 SC3003 | `aws-computed-assignment-final-20261003/probe.json` |
| Baldim adapter S3 original | 6 diagnósticos | 6 diagnósticos | `s3-client-computed-assignment-final-20261003/probe.json` |

No AWS, a família textual de atribuição a não variáveis caiu de 38 para 13 ocorrências: desapareceram as 25 atribuições computadas, incluindo `FieldPosition`, os dois enums `HEADER_VALUE_TYPE`, `getSmithyContext`, `signingKeyCache` e `traitsCache`. A família original SC1090 caiu de 404 para 379; as 321 SC2004 não mudaram. Ocorrências não são APIs independentes e essa redução não mede um percentual de compatibilidade do SDK.

Os SHA-256 das 30 fontes reportadas pelo probe AWS e das 706 reportadas pelo Baldim permaneceram iguais aos respectivos baselines da etapa anterior. O build AWS final levou 68.797 ms e teve RSS máximo de 554.360 KiB; o Baldim levou 96.414 ms e teve RSS máximo de 658.368 KiB. Esses tempos incluem a contenção da máquina durante testes e não são benchmarks de performance do compilador.

Os seis bloqueios do Baldim continuam sendo quatro SC2013 dos imports pino/recker, um SC2011 do agregado unknown impresso pelo consumidor e um SC1090 de `client.destroy`. Não existe novo binário S3, inicialização/destruição nativa qualificada ou prova de CRUD. Redwall e redskilled não foram reconstruídos nesta etapa.

## Validação do workspace e bloqueios de entrega

O build dos pacotes do workspace passou, incluindo compiler, CLI e cargo check do runtime Rust. O inventário de backend libCalls e o surface manifest foram regenerados a partir das fontes de decisão; as verificações locais de ambos passaram. `pnpm node-compat` encontrou EAI_AGAIN ao buscar nodejs.org; `pnpm node-compat --offline` regenerou os artefatos locais e `pnpm node-compat:check` passou, com 4.690 linhas internas e 3.662 públicas do pin Node 24.15.0. As classificações públicas e os artefatos públicos de docs não mudaram por esta etapa.

O comando `pnpm manifest` encontrou EPERM no socket de IPC do executável tsx. O mesmo script de geração foi executado e verificado com `node --import tsx`, sem alterar suas regras ou os arquivos gerados à mão. O arquivo gerado de backend libCalls também foi produzido por seu gerador. ESLint dos helpers novos e dos arquivos focados passou sem erros; permanecem sete warnings anteriores no teste de IR. `git diff --check` passou.

O gate global de tamanho de arquivos continua vermelho: reportou 33 arquivos acima dos limites ou ceilings legados, inclusive arquivos já em WIP antes desta etapa. Os dois novos helpers têm 43 e 26 linhas; os pontos de integração adicionam o routing e o contrato de IR necessários. Os ceilings foram mantidos; a redução dessa dívida permanece pendente.

Os dois gates completos foram tentados novamente com um worker e `--bail=1`, nas lanes plain e SCRIPTC_SAN=1. Ambos pararam após quatro testes passarem, no teste `new nested runtime headers invalidate complete and output-local artifacts`, em `native-toolchain.test.ts:228`, ao executar o binário C temporário `project/first`: spawnSync EPERM. As 415 suítes não foram completadas e não há green geral nem condição de shipping comprovada. Os contratos de teste foram mantidos.

`/tmp` estava cheio: um tmpfs de 4 GiB em RAM, com cerca de 11 MiB livres. Os temporários desta etapa foram redirecionados para `.red/tmp/` no disco do projeto. Uma primeira escolha dentro de `node_modules/.cache` fez fixtures temporários serem classificados como npm, pulando checks de preflight e causando nove falhas TDZ; o caminho foi corrigido, os dez testes TDZ passaram isolados e as duas rodadas finais completas de 61 testes passaram depois disso. O erro intermediário não foi tratado como regressão resolvida por uma mudança no compilador.

O limitador por cgroup não conseguiu acessar o user bus, com Operation not permitted. Foram usados um worker de teste, um job nativo, um Cargo job e heap Node de 1.536 MiB; esses controles não equivalem a um limite rígido de RAM. Um lease antigo de compilação também bloqueou uma primeira tentativa; ela foi cancelada e esta etapa usou um diretório de leases próprio, sem remover leases ou matar processos de outras sessões. Não houve limpeza destrutiva de `/tmp`.

O worktree anterior foi preservado. `.git` continua somente leitura neste ambiente; não houve commit, push ou reconciliação de origin/main. Gates gerais, revisão da dívida de tamanho e reconciliação permanecem necessários antes de entregar essas alterações.

## Próxima implementação proposta

O próximo slice recomendado é uma redução de classes retornadas por factories, antes de tentar novamente todos os comandos S3. O report final tem 113 recusas de `extends` computado: exemplos reais são `extends bindUint8ArrayBlobAdapter(...)` no serde Smithy e `extends command(_ep6, _mw0, "ListBuckets", ListBuckets$)` no cliente S3. `makeBuilder` retorna `makeCommand`, que encadeia `Command.classBuilder()` e `.build()`; `ClassBuilder.build()` retorna uma classe que captura o builder, usa `CommandRef`, inicializa campos, chama super e fornece métodos estáticos e de instância.

Reduzir esse padrão a corpus sem npm, primeiro com uma factory que retorna uma classe capturando configuração e depois com duas invocações distintas da factory. Fixar em testes a identidade das classes, identidade das instâncias, ordem dos efeitos, super, campos, construtores, métodos estáticos/virtuais e erros de new/extends inválidos. Auditar o lowering de mixins existente antes de decidir entre especialização estática e representação de construtores de runtime; chamadas de factory precisam preservar sua identidade e captura, não apenas apontar para um alias nominal.

As 13 recusas restantes de atribuição são outras formas, entre elas `url.search`, campos do endpoint, propriedades de funções, `globalThis.awslambda` e metadata de retries. Elas merecem reduções separadas por representação e não uma conversão automática de todo receiver para mapa. As frentes pino/recker e DNS IPv4/IPv6 continuam na sequência descrita no checkpoint anterior, seguidas da inicialização/destruição do adapter e de S3 local controlado. Uma biblioteca Rust de APIs Node ajuda essas frentes, mas não substitui a semântica de classes, closures e atribuições corrigida ou ainda pendente no frontend.

A disciplina de contexto e diagnóstico manteve a reprodução mínima, o ciclo red-green e a comparação com fontes originais. O checkpoint separa comportamento executado, recusas e condições de entrega para a próxima sessão não confundir uma família resolvida com o Baldim inteiro compilado.
