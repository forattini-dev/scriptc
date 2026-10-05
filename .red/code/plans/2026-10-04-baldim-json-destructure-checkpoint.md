# Baldim e require de JSON com desestruturação

Em 4 de outubro de 2026, scriptc passou a compilar padrões planos de objeto em require de JSON, incluindo a forma const { version } = require("./package.json") usada pelo thread-stream. A análise do Baldim original deixou de recusar esse pacote por causa dessa sintaxe. O build do consumidor completo continua falhando com cinco diagnósticos e não gerou um binário; admissão estática do pacote não comprova execução de seus workers nem operações S3.

Esta etapa continua [o checkpoint dos métodos assíncronos](./2026-10-04-baldim-js-async-methods-checkpoint.md). Rust permaneceu stable 1.98.0. O foco foi Node 26, usando o executável disponível 26.10.0, diferente do pin 26.8.1. Node 24.15.0 serviu como oracle secundário. Não houve instalação ou uso de nightly.

## Diagnóstico atualizado

A análise nova do entry original confirmou fallback de pino por atomic-sleep, de recker por node:dns/promises e de thread-stream por desestruturação de require de JSON. Atomic-sleep, on-exit-leak-free e quick-format-unescaped também recebem a recusa de admissão automática por ausência de declarações próprias. Esses são motivos independentes; implementar a sintaxe de JSON não remove a política de tipos das outras dependências.

O compiler já reconhecia require de JSON com binding identificador. A preflight recusava o padrão de objeto, o coletor não registrava seus bindings e a declaração de require era tratada como alias sem armazenamento. Um corpus mínimo reproduziu SC1012 e uma recusa de referência ao campo. O checker fornece o tipo estrutural completo do documento tanto para o padrão quanto para a chamada, permitindo reutilizar o mapeamento e o bake existentes.

A leitura do coletor anterior também identificou uma divergência: cada importador atribuía novamente o documento ao global compartilhado, podendo apagar mutações realizadas por um módulo anterior. O teste entre módulos protege essa fronteira. A correção preserva uma única inicialização por documento e separa o snapshot do binding primitivo da identidade compartilhada de objetos aninhados.

## Implementação e fronteiras

O novo lower-json-imports.ts concentra a coleta de JSON, extraída de lower-modules.ts. Um global de documento e um guard de inicialização são compartilhados pelo caminho resolvido. Imports identificadores continuam lendo o documento em cache; padrões planos de require recebem globals próprios e são preenchidos pela desestruturação ordinária na posição da declaração. Essa distinção mantém os valores primitivos capturados e as referências a objetos aninhados compartilhadas.

lowerer registra o documento de cada declaração com padrão em jsonRequireBindings. lower-stmts utiliza esse valor como initializer da desestruturação, sem converter require em uma operação de engine. A preflight admite apenas o recorte plano já verificado: shorthand, renomeação e chaves literais. Defaults, rest, padrões aninhados, padrões de array, chaves computadas e chamadas bare mantêm recusas explícitas. Os guards de TDZ continuam ativos. Não houve ampliação das políticas de npm-static, das tabelas de APIs, do IR ou dos runtimes.

O corpus não qualifica reatribuição de um binding let vindo de JSON. Durante a minimização, o checker produziu uma recusa de atribuição a import para essa forma; ela não foi suprimida. Os testes positivos desta etapa usam const e mutações dos objetos compartilhados.

Os jobs CI das duas versões do Node incluem cjs-json-destructure.test.ts. A fixture negativa json-require-forms agora verifica defaults e bare require; seu snapshot foi atualizado a partir dos diagnósticos reais. Não foram atualizados snapshots fora desse recorte.

## Evidência de execução

Os novos corpus são 3441-cjs-json-destructure/main.cjs e 3442-cjs-json-destructure-cache/main.cjs. O primeiro cobre shorthand, renomeação, chave literal, campo numérico, objeto aninhado, array e leitura de bindings por uma função. O segundo modifica o documento antes e depois do require de um módulo consumidor: o valor primitivo conserva o snapshot anterior, enquanto o objeto aninhado observa a mutação posterior.

cjs-json-destructure.test.ts tem dez testes: dois de análise, dois diferenciais novos executados em Rust dev e release, duas regressões de imports JSON existentes e quatro recusas verificadas tanto na análise quanto no build. As regressões existentes reutilizam o corpus 1359 de import ESM e a fixture npm jsonzoo de require identificador e múltiplos importadores. As seis compilações positivas Rust por oracle exigem engine none, externalFfi false e runtimeFences vazias; executam com SCRIPTC_RUST_HEAP_AUDIT=1 e comparam stdout, stderr, código de saída e sinal com Node.

A rodada final Node 26 passou com vinte testes em dois arquivos, incluindo os dez testes de require-tdz, em 37,23 s. A rodada Node 24 passou com os mesmos vinte testes em 62,02 s. Esses tempos incluem compilação e contenção pelos jobs nativos compartilhados, não são benchmarks. Os dois testes Rust de export CommonJS antes de require também passaram numa rodada anterior. Seis snapshots focados de JSON, import forms e TDZ passaram na rodada final.

O driver .red/tmp/json-destructure-backend-smoke-20261004.mjs executou os dois novos corpus em C e LLVM, com e sem sanitize, oito builds dev. Todos reproduziram os bytes e o status do Node 26. A primeira execução sanitizada sem ajuste ambiental abortou no LeakSanitizer, que informou não funcionar sob ptrace. A rodada positiva usou ASAN_OPTIONS=detect_leaks=0: AddressSanitizer e SCR_RC_AUDIT continuaram ativos nos builds sanitizados, mas essa rodada não valida o LeakSanitizer nem substitui o gate completo. O driver captura stdio em arquivos regulares porque o sandbox recusa algumas execuções com pipes síncronos.

## Build do Baldim original

O consumidor permaneceu .red/tmp/baldim-rust-20261001-nDbseO/s3-client.ts, com @baldim/adapter-s3 0.1.2 e @baldim/core 0.2.1 instalados. As opções foram backend rust, target node26, npmStatic auto, optimization dev e allowEngine false. O entry constrói o cliente com credenciais fictícias, taskExecutor false e useReckerHandler false, imprime sua configuração e chama destroy. Não executa send, CRUD ou acesso AWS.

Os artefatos da análise antes e depois e do novo build ficam em [.red/tmp/baldim-dependency-tests-20261004-nqIsO8](../../tmp/baldim-dependency-tests-20261004-nqIsO8): analysis-before/probe.json, analysis-json-after/probe.json e build-json-after/probe.json. A análise anterior levou 94.266 ms; a análise posterior, 98.192 ms, com RSS máximo de 680.324 KiB. O build posterior falhou em 84.753 ms, com RSS máximo de 647.780 KiB.

O status de thread-stream mudou de fallback com SC1012 para static na etapa de admissão automática. As fontes observadas aumentaram de 706 para 710: o compiler passou a incluir thread-stream/index.js, package.json, lib/wait.js e lib/indexes.js. Os hashes das 706 fontes anteriores, inclusive o consumidor, permaneceram iguais; não houve remoções nem edição dos pacotes instalados.

O build completo conserva quatro SC2013, uma para pino e três para subpaths de recker, e uma SC2011 no agregado unknown do consumidor. O motivo atual de pino continua sendo atomic-sleep; o de recker, node:dns/promises. Não há binário gerado nem prova de funcionamento completo do Baldim, AWS SDK, thread-stream, redwall ou redskilled nesta etapa.

## Validação e entrega pendente

O build do workspace passou, incluindo compiler, CLI e cargo check. ESLint dos dois arquivos novos passou sem warnings; os arquivos legados tocados não apresentam erros de ESLint, mas mantêm 157 warnings. A sintaxe YAML dos doze jobs, git diff --check, o surface manifest com 667 entradas e node-compat:check com 54 módulos, 4.690 linhas internas e 3.662 linhas públicas passaram. Nenhuma tabela de API ou artefato público mudou nesta etapa; não houve regeneração de compatibilidade nem necessidade de gate do site por esta mudança.

Uma seleção inicial mais ampla de snapshots encontrou drift em json-dyn.ts, fora do import de documentos JSON, além da atualização esperada de json-require-forms. O primeiro snapshot não foi alterado; a seleção focada final de seis contratos passou. Isso não equivale a uma execução verde de todo o corpus de diagnósticos.

As lanes completas plain e SCRIPTC_SAN=1 foram tentadas com um worker e bail no primeiro erro. Ambas pararam em native-toolchain.test.ts:228, no execFileSync do teste de headers, com EPERM. Quatro testes anteriores passaram em cada lane; os 421 arquivos não foram concluídos. A plain levou 8,72 s; a sanitized levou 25,88 s, incluindo espera pelo lock compartilhado. O gate de tamanho continua vermelho com 33 violações no WIP; os ceilings não foram aumentados. A extração do coletor não resolve toda a dívida de tamanho dos arquivos legados.

O limiter foi tentado e não pôde conectar ao bus de usuário. Os controles efetivos foram um worker por runner, um job Cargo, um job nativo compartilhado e heap Node de 1.536 MiB; não são um teto rígido de RAM. Os temporários ficaram no disco sob .red/tmp porque /tmp estava cheio. Artefatos de diagnóstico e trabalho de outras sessões foram preservados.

Não houve commit ou push. A tentativa de fetch foi impedida por .git/FETCH_HEAD em filesystem somente leitura; a referência origin/main em cache não comprova reconciliação atual com o remoto. Os dois gates completos, a dívida de tamanho e a reconciliação continuam necessários antes de shipping.

dev:diagnose orientou a reprodução, o teste diferencial antes da implementação e a nova tentativa do consumidor real. dev:context usou código e checkpoints porque Memory e Wiki não estão inicializados. A leitura de dev:guard-serialization identificou JSON como entrada externa do programa compilado, não armazenamento interno para migrar; o guard de TOON do redskilled não existe neste repositório. pages:write-page orientou a separação entre evidência local, admissão de pacote e execução ainda não comprovada.

## Próximas frentes

1. Minimizar a dependência atomic-sleep e separar a política de admissão sem declarações do lowering real de seus exports condicionais, parâmetros e Atomics.wait. O compiler já tem uma primitiva nativa de Atomics.wait com timeout; isso não prova que o pacote inteiro compila. Uma mudança genérica de admissão deve preservar as fronteiras de bibliotecas e recusas por tipos não representáveis, em vez de simplesmente remover o requisito de declarações.
2. Investigar a família dns/promises usada por recker, começando por lookup com famílias 4 e 6, Promise, formato de erros e ordem de callbacks. O runtime Rust atual de dns.lookup só admite família 4 e resolve de forma síncrona antes de entregar callback no próximo turn; adicionar apenas um alias de módulo não reproduziria a família exigida pelo consumidor. Antes de implementar, confirmar o backlog, a documentação oficial e os oracles dos dois alvos.
3. Repetir análise e build do Baldim original após cada correção, mantendo hashes e opções. Depois que os imports forem admitidos, investigar o agregado unknown e as recusas alcançadas nos corpos de AWS e Smithy. Só declarar fechamento quando o binário Rust sem engine executar o probe e os cenários S3 definidos, não quando uma linha de inventário disser static.
