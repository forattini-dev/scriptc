# Separação entre tipos e execução no compilador

O compilador agora restringe a admissão estrutural de runtime aos arquivos alcançados por arestas executáveis, mantendo o universo de tipos do checker. O witness original que falhava com SC1010 passa sem engine. A validação final passou 64 testes focados e 18 testes de execução no harness oficial. Os gates amplos continuam vermelhos: ambos encontram uma recusa Rust em um spread de record com await. Estas alterações permanecem locais, sem commit ou push pelo agente.

Atualização posterior em 2026-10-01: a recusa de spread com await foi corrigida no [checkpoint de suspensão em objetos ordenados](2026-10-01-async-ordered-record-checkpoint.md), com a regressão original e o novo corpus passando contra Node. Novas tentativas dos gates completos estão em execução. Os resultados abaixo preservam o estado medido ao concluir a etapa do grafo, não o resultado dessas tentativas novas.

Este passo continua o [levantamento TS para Rust estável](../../researches/2026-09-30-ts-rust-stable-dogfood.md) e o [checkpoint de ordem por instância](2026-09-30-record-instance-order-checkpoint.md). Foram usados Rust estável 1.98.1, Node 24.15.0 e Bun 1.3.14, sem nightly. A versão exata 1.98.0 fixada pelo gate próprio do runtime Rust não foi validada neste passo. O frontend alterado é compartilhado; a evidência executável aqui qualifica o backend Rust, não garante paridade integral dos backends C e LLVM.

## Causa e implementação

O loader já reconhecia import type como uma aresta apagada, mas o preflight percorria todos os arquivos de implementação presentes no programa do checker. Um módulo necessário apenas para obter uma interface podia trazer imports e recusas de runtime que Node nunca executava. O [witness anterior](../../tmp/ts-rust-stable-audit-20260930/results/typegraph-before/probe.json) registra SC1010 na dependência ambient; a [análise final do mesmo witness](../../tmp/ts-rust-stable-audit-20260930/results/typegraph-original-final/probe.json) não tem diagnósticos.

[runtime-source-files.ts](../../../packages/compiler/src/frontend/runtime-source-files.ts) calcula a alcançabilidade a partir da entrada. Arestas estáticas usam a mesma resolução de orderedImportsOf; chamadas literais de import, require CommonJS, bindings canônicos de createRequire e targets selecionados de fork também entram na admissão. Imports dinâmicos e filhos não viram dependências de inicialização do processo principal. A identidade de cada arquivo encerra ciclos e a ordem original do checker mantém os diagnósticos determinísticos.

[program.ts](../../../packages/compiler/src/frontend/program.ts) aplica essa seleção depois da verificação de tipos, antes das recusas estruturais. Os testes mantêm erros reais de atribuição tanto no importador quanto dentro de um módulo apagado. A seleção não transforma uma dependência necessária para o checker em opcional nem suprime SC0001.

## Imports inline e diferenças entre oráculos

A comparação executável encontrou uma regra que o código anterior confundia: no Node, import type apaga a declaração, mas import com um binding inline type mantém a avaliação do módulo, mesmo quando nenhum binding de valor sobra. A [documentação oficial de verbatimModuleSyntax](https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html) explicita a transformação para import vazio; o contrato desta implementação foi confirmado executando Node 24.15.0. A mesma família inline foi executada sob Bun 1.3.14, que apaga essas arestas. Não se generaliza o comportamento de um oráculo para o outro.

[module-erasure.ts](../../../packages/compiler/src/frontend/module-erasure.ts) centraliza a decisão por target. Preflight, ordem de inicialização, link checks, planejamento npm e coleta de imports compartilham essa decisão. Imports e exports explicitamente vazios continuam com efeitos de módulo; bindings individuais type nunca se tornam valores.

Uma segunda comparação encontrou um reexport npm admitido como estático que era tratado pelo atalho de importação island antes de registrar sua aresta de inicialização. O compilado omitia uma mensagem presente no Node. O preflight agora reserva esse atalho aos pacotes que não foram admitidos como estáticos. A coleta também preserva loads sem bindings de valor, em vez de deixar um import vazio sem ações. A comparação [antes](../../tmp/ts-rust-stable-audit-20260930/typegraph-npm.log) e [depois](../../tmp/ts-rust-stable-audit-20260930/typegraph-npm-final.log) registra a divergência e sua correção.

## Evidência permanente e validação

Os corpora [3336](../../../tests/corpus/3336-type-only-runtime-graph/main.ts), [3337](../../../tests/corpus/3337-type-only-link-graph/main.ts) e [3338](../../../tests/corpus/3338-bun-inline-type-graph/main.ts) cobrem apagamento completo, dependência transitiva com runtime indisponível, ciclo apenas de tipos, efeitos de import e reexport inline e a diferença do target Bun. O [fixture npm](../../../tests/fixtures/type-only-npm-graph/main.ts) tem seu [harness diferencial](../../../tests/harness/type-only-npm-graph.test.ts), que fornece npmStatic auto explicitamente. Ele não permanece no corpus geral, cujo runner não configura essa opção. Nenhum harness foi relaxado para esconder diferenças de stdout, stderr ou status.

O [teste público da API](../../../packages/compiler/test/type-only-runtime-graph.test.ts) mantém os controles de imports de valor, bindings mistos, import vazio, side effects, reexports, import dinâmico, createRequire com nome alternativo e fork. O [gate focado final](../../tmp/ts-rust-stable-audit-20260930/typegraph-api-checkpoint.log) passou 64 testes em seis arquivos, incluindo admissão nativa existente, pruning npm e lifecycle do checker.

A [seleção final de execução](../../tmp/ts-rust-stable-audit-20260930/typegraph-official-checkpoint.log) passou 18 testes em três arquivos: 16 corpora selecionados no harness Rust oficial, o diferencial npm e o contrato de string.at. São casos selecionados, não uma execução de todos os 1948 programas do corpus. Os novos fixtures foram compilados com engine none, zero runtime fences e sem FFI externo; as execuções nativas usaram auditoria de heap. A evidência de execução inclui as regressões anteriores de ordem e presença, imports dinâmicos, fork e grafos de módulos.

O [build](../../tmp/ts-rust-stable-audit-20260930/typegraph-build-final.log), o [ESLint dirigido](../../tmp/ts-rust-stable-audit-20260930/typegraph-eslint-checkpoint.log), o [manifesto](../../tmp/ts-rust-stable-audit-20260930/typegraph-manifest-final.log) e o [check de compatibilidade](../../tmp/ts-rust-stable-audit-20260930/typegraph-compat-checkpoint.log) passaram. O manifesto gerado e os artefatos de compatibilidade não tiveram diff. Não foram alterados status públicos de suporte.

## Renderer original e dependência do consumidor

A [análise final do renderer original](../../tmp/ts-rust-stable-audit-20260930/results/typegraph-renderer-final/probe.json) perdeu a recusa SC1010 de runtime, mas conserva SC0001: o checker não encontra tuiuiu.js/red-dev em red-dev/src/ui.ts. Não se afirma que o renderer inteiro compilou ou que seus PNGs passaram neste passo.

Há um problema concreto a resolver no consumidor antes dessa qualificação: red-dev não tem node_modules instalado e declara tuiuiu.js no commit 10c311d3bd73f7f6f74c45ddde204907e021bdbe; o package.json desse commit, inspecionado com git show no checkout irmão, não exporta o subpath red-dev. Portanto, simplesmente instalar a dependência declarada não estabelece que esse import ficará válido. A worktree de tuiuiu.js tem WIP alheio, que foi preservado. Nenhum consumidor, pacote irmão, daemon, serviço ou provisionamento foi alterado.

## Gates amplos e próximo bloqueio

Com as permissões liberadas, spawn e acesso ao Git funcionaram. A execução ampla encontrou um teste antigo de string.at esperando uma exceção fora do limite. Node 24.15.0 e o compilado retornam undefined nesse caso. O teste agora compara o resultado inteiro contra Node e mantém uma expectativa literal do oráculo; essa correção passou na seleção final. O helper interno Rust que lança fora do limite não foi modificado: não se confunde seu contrato interno com o método JavaScript já admitido pelo frontend.

Depois dessa correção, as lanes [plain](../../tmp/ts-rust-stable-audit-20260930/typegraph-plain-after-oracle.log) e [sanitizada](../../tmp/ts-rust-stable-audit-20260930/typegraph-san-after-oracle.log), com bail no primeiro erro, falharam no teste existente Rust record clones preserve evaluation across async suspension. Ambas passaram 20 testes antes da recusa nested async value in the Rust state-machine subset. Elas não são gates completos aprovados. A lane sanitizada ordinária não torna nightly ou Rust ASan requisitos desta entrega. Tentativas anteriores interrompidas durante a investigação não foram contadas como verdes.

O próximo passo de implementação é minimizar esse spread com campo await, preservar avaliação anterior e posterior à suspensão, ordem de chaves, efeitos únicos da origem, aliasing e finally, e estender a máquina de estados Rust com evidência diferencial. As recusas em [async-values.ts](../../../packages/compiler/src/backend/rust/async-values.ts) e [async-control.ts](../../../packages/compiler/src/backend/rust/async-control.ts) são os pontos iniciais de inspeção. Não se afirma ainda se a regressão veio de uma correção anterior de ordem ou de outro limite do backend.

O [lint global](../../tmp/ts-rust-stable-audit-20260930/typegraph-lint-full.log) continua falhando nos ceilings de arquivos mantidos. Os limites não foram aumentados. Array.from de Uint8Array, o runner Test262 Rust, o contrato de compressão PNG e benchmarks atuais continuam pendentes; este passo não os implementa.

## Checkpoint e recursos da máquina

O [fetch final](../../tmp/ts-rust-stable-audit-20260930/typegraph-fetch-checkpoint.log) funcionou e a comparação confirmou HEAD e origin/main alinhados em 0ce66607. O checkpoint publicado continua sendo o do mantenedor; o agente não fez add, commit ou push destas novas alterações. WIP anterior foi preservado.

O limitador por cgroup voltou a funcionar. Com capacidade disponível, os gates finais usaram teto de duas CPUs, memory high de 4 GiB, limite rígido de 6 GiB, sem swap e um worker de teste, compiler nativo e Cargo. A leitura final da máquina tinha aproximadamente 15 GiB disponíveis e swap sem uso. Somente execuções de teste iniciadas pelo agente foram interrompidas ao congelar a implementação; nenhum processo externo foi encerrado. Não há evidência de RAM tomada impedindo esta etapa.
