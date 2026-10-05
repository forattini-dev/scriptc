# Baldim e classes retornadas por factories

Em 3 de outubro de 2026, scriptc passou a compilar uma família restrita de factories que retornam classes e capturam parâmetros, sem engine JavaScript nem FFI externa. Os 81 testes focados passaram tanto no Node 26.10.0 quanto no Node 24.15.0. O Baldim/S3 original ainda não gera binário: permanece com seis diagnósticos externos, e o SDK AWS isolado mantém 1.055 recusas, incluindo 113 de extends computado. Esta etapa resolve a base de captura e identidade, não o builder completo usado pelo Smithy.

Este checkpoint continua [a etapa de atribuições computadas](./2026-10-03-baldim-computed-assignment-checkpoint.md). As fontes npm foram preservadas e não houve instalação ou uso de nightly. O Rust executado continua sendo o stable 1.98.0.

## Família implementada

O helper `packages/compiler/src/frontend/lowering/class-factory-captures.ts` reconhece funções declaradas e bindings const de arrows ou function expressions cujo corpo retorna diretamente uma classe anônima que estende uma classe de programa conhecida. A chamada deve estar em um único inicializador const de topo ou no heritage de uma declaração de classe de topo. Parâmetros precisam ser simples, sem defaults, optional, rest ou destructuring, e a chamada deve fornecer exatamente essa aridade sem spread. O corpo não pode conter outros statements: seus efeitos não são descartados por uma especialização presumida.

Cada chamada ganha sua própria instância nominal e suas próprias células de captura, usando a infraestrutura existente de mixins. Os argumentos são avaliados uma vez, em ordem, no ponto da chamada e antes dos inicializadores estáticos. Argumentos não usados também são avaliados. Objetos capturados conservam a identidade exercitada pelos corpus; reatribuir a variável do argumento depois da chamada não troca a célula capturada. Reatribuir o parâmetro dentro de um método muda a célula compartilhada pelas instâncias daquela classe, sem alterar a captura de outra chamada da factory.

Construtores, inicializadores de campos, métodos de instância e métodos estáticos baixam sob o ambiente da instância especializada. Os callbacks retornados por métodos podem ler esse ambiente depois, inclusive após a troca do callback capturado. Bindings const sem anotação inicializados por new de um resultado da factory usam a classe concreta do initializer, sem tentar adivinhar uma instância a partir do nó de classe compartilhado pelo checker.

Os testes revelaram uma colisão anterior na alocação de campos estáticos de mixins: o identificador era derivado do nó de classe, compartilhado por duas instanciações. A alocação agora usa o nome da instância do mixin, de modo que duas chamadas não sobrescrevam o mesmo campo. O corpus de mixins testa também a escrita posterior em um dos campos sem mudar o outro. A alteração não introduz uma nova operação de IR, um novo formato de serialização ou um novo runtime Rust.

## Limites mantidos

Chamadas dentro de funções continuam recusadas porque uma posição de chamada pode executar várias vezes e criar classes distintas. Declarações com múltiplos declarators, chamadas com defaults ou aridade não exata, bases ainda em TDZ e factories const usadas antes da inicialização mantêm fronteiras explícitas. Factories em módulos CommonJS importados também são recusadas: um require que falha pode ser repetido, e uma classe imortal por call site não preservaria essa identidade. A família testada usa inicialização de entrada ou ESM, sem generalizar a especialização para reexecução de módulos.

Classes nomeadas retornadas por factories, bases selecionadas em runtime, classes sobre typed arrays ou outros builtins, factories com statements intermediários e factories que retornam builders ou outras funções não estão abrangidas por este helper. Métodos de builders que capturam this e atribuem um CommandRef também não estão abrangidos. Nenhuma dessas fronteiras foi convertida em suporte público presumido.

## Evidência executada

Os sete programas novos são `3424-ts-class-factory-capture.ts`, `3425-ts-class-factory-order.ts`, `3426-js-class-factory-capture.mjs`, `3427-ts-class-factory-callbacks.ts`, `3428-ts-mixin-statics-distinct.ts`, `3429-ts-class-factory-constructor-errors.ts` e `3430-js-class-factory-modules/main.mjs`. O último usa uma factory exportada por outro módulo ESM. O primeiro reproduziu SC1090 de extends computado antes da implementação; o segundo revelou a colisão de campos estáticos depois da primeira implementação.

`packages/compiler/test/class-factory-capture.test.ts` contém 14 execuções positivas, dev e release para os sete programas, e cinco testes de recusas. Cada execução positiva compara stdout, stderr, status e sinal contra Node e exige engine none, externalFfi false, runtimeFences vazias e auditoria do heap Rust. `class-factory-captures.test.ts` valida a IR e os identificadores independentes das quatro células de captura e dos dois campos estáticos. Os dois arquivos foram adicionados às etapas CI de foco Node 26 e compatibilidade Node 24.

A rodada de 11 arquivos passou com 81 testes em cada Node: os 20 testes novos e 61 regressões anteriores de atribuição computada, CommonJS, factories, TDZ, valores Rust, módulos nativos e validação da IR. Node 26.10.0 foi o executável de foco disponível, não o pin 26.8.1; Node 24.15.0 foi a compatibilidade executada. As rodadas levaram 245,40 s e 354,88 s, respectivamente. A segunda sofreu contenção de compilação nativa durante outras verificações; esses tempos não são benchmarks.

Dois corpus, `3425-ts-class-factory-order.ts` e `3428-ts-mixin-statics-distinct.ts`, também foram compilados e executados diretamente nos backends C e LLVM, quatro builds sem engine, usando Node 26 como oracle e captura de stdio por arquivos. Todos coincidiram byte a byte. O snapshot legado de `tests/diagnostics/mixins.ts` passou sem atualização.

## Reteste do AWS e do Baldim originais

Os probes continuam sendo consumidores de construção e configuração com credenciais fictícias e nenhum send ou CRUD. O prefixo dos reports é `.red/tmp/baldim-rust-20261001-nDbseO/results/`.

| Probe | Diagnósticos anteriores | Diagnósticos atuais | Report atual |
| --- | --- | --- | --- |
| AWS S3Client isolado | 1.055 | 1.055 | `aws-class-factory-20261003/probe.json` |
| Baldim adapter S3 original | 6 | 6 | `s3-client-class-factory-20261003/probe.json` |

O AWS manteve suas 113 recusas de extends computado. O build de diagnóstico levou 36.592 ms e teve RSS máximo de 537.836 KiB. O Baldim levou 88.558 ms e teve RSS máximo de 662.476 KiB. Os SHA-256 das 30 fontes reportadas pelo AWS e das 706 reportadas pelo Baldim continuam iguais aos baselines anteriores. Os resultados não qualificam binário S3, inicialização e destruição nativas, operações de bucket ou CRUD. Redwall e redskilled não foram reconstruídos nesta etapa.

O Baldim continua bloqueado pelos quatro SC2013 de imports pino/recker, um SC2011 do agregado unknown impresso pelo consumidor e um SC1090 de client.destroy. Reduzir o número desses diagnósticos externos sem executar as dependências originais não demonstraria a compilação completa do adapter.

## Validação e condições de entrega

O build dos pacotes do workspace passou, incluindo compiler, CLI e cargo check do runtime Rust. ESLint dos arquivos tocados passou com zero erros e 243 warnings nos arquivos legados; os três arquivos novos de implementação e testes passaram sem warnings. `git diff --check`, a sintaxe YAML dos 12 jobs CI, o check do surface manifest com 667 entradas, o check de backend libCalls com 1.299 spellings e `pnpm node-compat:check` passaram. O inventário Node continua com 4.690 linhas internas e 3.662 públicas do pin Node 24.15.0. Esta etapa não alterou tabelas de decisão de APIs, manifests ou artefatos públicos de compatibilidade; não houve claim positivo novo de API Node nem necessidade de regeneração ou de build do site de docs.

O gate global de tamanho continua vermelho, com 33 arquivos acima de seus limites ou ceilings legados. Os ceilings não foram aumentados. O helper novo tem 132 linhas e o teste unitário tem 26; os arquivos legados receberam os pontos de integração e continuam exigindo uma redução revisada antes de shipping.

As duas lanes completas foram tentadas novamente com um worker e bail no primeiro erro. Plain e SCRIPTC_SAN=1 pararam após quatro testes passarem no mesmo `native-toolchain.test.ts:228`, ao executar o binário C temporário com execFileSync: EPERM. As 417 suítes não foram completadas. Uma tentativa adicional de executar o corpus de ordem com sanitize true nos backends C e LLVM compilou os programas, mas ambos terminaram com a falha de ambiente `LeakSanitizer does not work under ptrace`. Não houve desativação do LeakSanitizer ou alteração desses contratos para declarar green. Os testes Rust dev e release usaram sua auditoria de heap; não foi tentada a lane ASan Rust que exige nightly.

O limitador por cgroup continua sem acesso ao user bus. Foram usados um worker de teste, um job nativo, um Cargo job e heap Node de 1.536 MiB; isso não é um limite rígido de RAM. `/tmp` continua cheio, então os temporários ficaram em `.red/tmp/` no disco. Uma primeira invocação do gate completo com separador de argumentos inadequado foi cancelada; seu lock ficou opaco entre namespaces. Os gates finais usaram um diretório temporário próprio com o mecanismo de lock ativo, sem apagar locks ou matar processos de outras sessões.

O WIP anterior foi preservado. Não houve commit, push ou fetch: `.git` continua somente leitura no ambiente. Os refs locais HEAD e origin/main estavam iguais, mas isso não substitui um fetch nem prova que o remoto atual foi reconciliado. Reconciliação, redução da dívida de tamanho e gates completos continuam necessários antes de entregar.

## Próximo recorte do Smithy

O próximo alvo está reproduzido em `.red/tmp/smithy-class-builder-repro-20261003.mjs`, com report em `.red/tmp/smithy-class-builder-red-20261003/probe.json`. O Node imprime `first second 7`, depois `true true` e `false true false`. O build Rust ainda dá cinco SC3003 que encapsulam as fronteiras originais, começando por SC1090 de extends computado. A redução não depende de npm e preserva o ponto relevante do SDK: ClassBuilder.build captura this em closure, atribui CommandRef a uma classe retornada e usa a mesma referência em métodos posteriores.

A sequência proposta é especializar esse ambiente de builder sem apagar seus efeitos, preservar a identidade do CommandRef separado da classe derivada, e admitir a chamada de método que devolve a classe. Depois, executar duas invocações independentes, mutação de configuração, construtor e método estático contra os dois Node. Só após esse recorte ficar green deve-se incorporar o encadeamento de makeBuilder e makeCommand do SDK e retestar suas fontes originais.

Essa especialização não basta para chamadas repetidas em funções ou módulos recarregáveis. A implementação atual de classval em Rust usa um usize de metadata estática, e classRef emite o ordinal nominal; uma classe criada em runtime precisa de identidade, ambiente lexical e campos estáticos próprios, com new e instanceof coerentes. Essa observação vem de `packages/compiler/src/backend/rust/values.ts`, `expressions.ts` e `class-graph.ts`, não de uma suposição de que substituir APIs Node por funções Rust resolveria o frontend. A decisão de expandir essa representação deve manter a recusa explícita enquanto a semântica generativa não estiver implementada e testada.

As skills de contexto e diagnóstico mantiveram a reprodução mínima e a comparação com os consumidores originais. A disciplina editorial do checkpoint separa o recorte executado, a redução ainda vermelha e os bloqueios de entrega, sem converter a base implementada em uma declaração de que o Baldim já compila.
