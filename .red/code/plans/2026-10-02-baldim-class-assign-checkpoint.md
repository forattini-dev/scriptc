# Baldim: atribuição em classes nativas e último bloqueio observado

Data: 2026-10-02. Esta etapa implementou uma fatia de `Object.assign(target, source)` para classes nativas, com Rust 1.98.0 estável e sem engine JavaScript. Os dois probes originais de `@baldim/core@0.2.1` passaram de quatro diagnósticos para um, `Error.captureStackTrace`. Nenhum deles gerou binário: o pacote ainda não está qualificado para execução nativa. Nenhum consumidor, credencial, serviço ou operação S3 foi alterado ou executado, e não houve commit ou push.

## Diagnóstico e implementação

O teste inicial falhou em `Object.assign(this, merged)`. Um probe que substituiu apenas essa chamada por atribuições explícitas aos mesmos campos passou contra Node, incluindo identidade e armazenamento herdado. Isso isolou a admissão e o lowering de Object.assign, em vez de atribuir o problema ao layout das classes. O probe está em `.red/tmp/baldim-rust-20261001-nDbseO/object-assign-class-explicit-probe.js`.

O lowering novo fica em [lower-object-assign-class.ts](../../../packages/compiler/src/frontend/lowering/lower-object-assign-class.ts), chamado pelo roteamento existente dos statics de Object. A fonte record fechada avalia alvo e fonte uma vez e escreve nos slots declarados, com upcast para o dono do armazenamento herdado. A fonte checked-dynamic percorre suas chaves próprias efetivamente presentes, verifica cada chave e escreve no slot correspondente; o retorno preserva a identidade do alvo. Fontes dynamic null e undefined são ignoradas, sem perder a avaliação dos argumentos.

Os testes positivos fixam a diferença entre propriedade ausente e valor undefined presente, identidade de objetos compartilhados, valores herdados, retorno do próprio alvo e ordem de avaliação de alvo e fonte. Os programas permanentes são [3381](../../../tests/corpus/3381-js-object-assign-class.js), [3382](../../../tests/corpus/3382-js-object-assign-class-dynamic.js) e [3383](../../../tests/corpus/3383-object-assign-class-presence.ts). O primeiro ensaio de 3382 tinha um spread dynamic que falhou por outra recusa; esse ensaio foi minimizado para testar exclusivamente Object.assign. Não foi implementado suporte genérico novo de spread nesta etapa.

O helper IR `dyn.objectAssignSourceCheck` tem assinatura validada, classificação may-throw e emissão em Rust, C e LLVM. O inventário de backend libCalls foi regenerado pelo script, não editado à mão, e agora contém 1292 spellings. A guarda de fontes reaproveita a implementação do object rest, preservando sua mensagem anterior e seus testes. No runtime Rust, a inspeção de presença de propriedades Symbol acompanha aliases e projeções de mapas, inclusive projeções aninhadas, sem ler ou converter valores.

## Fronteiras preservadas

Esta implementação admite exatamente dois argumentos sem spread. O alvo tem layout nativo de classe e a cópia cobre campos públicos com chave de texto e tipos compatíveis. Não foi acrescentado armazenamento genérico para expandos, Symbol ou propriedades com descritores no alvo. Fontes record com accessors, índices, tuples ou slots union com undefined conservam suas recusas; o caminho dynamic é a fatia testada para presença real de chaves opcionais.

Uma chave dynamic desconhecida produz SC1031 na sua posição de cópia, depois das escritas anteriores, em vez de ser descartada. Fontes dynamic não ordinárias, com descritores ou com propriedades Symbol são recusadas explicitamente. A fronteira Symbol é deliberadamente conservadora: inclui Symbol não enumerável; não se está afirmando suporte à enumeração de Symbol ou aos seus descritores. Uma chave de texto como `"#count"` não pode escrever no armazenamento de um campo privado homônimo: essa fonte fechada conserva uma recusa de compilação. Setters, coerção arbitrária de PropertyKey, formas variádicas e atualização de campos de tipos incompatíveis não foram qualificados por esta etapa.

## Probes do pacote original

- [Chaves válidas](../../tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-assign-final-20261002/probe.json): build Rust sem engine recusado, com um SC3003 envolvendo a ausência de lowering de Error.captureStackTrace; 1744 ms e 391088 KiB de RSS do processo de probe.
- [Validação com erro](../../tmp/baldim-rust-20261001-nDbseO/results/core-storage-key-invalid-assign-final-20261002/probe.json): mesma recusa única; 1795 ms e 386496 KiB de RSS do processo de probe.

Os relatórios registram hashes dos consumidores e dos dois arquivos originais alcançados do pacote. O RSS reportado é do probe, não um pico agregado de todos os processos de compilação. A recusa única é o bloqueio observado nestes dois grafos, não uma demonstração de que todo o pacote e suas operações S3 estejam a uma única feature de funcionar.

## Validação

- `object-assign-class.test.ts`: 15 testes verdes; nove diferenciais positivos em Rust/C/LLVM, cinco fronteiras runtime explícitas e uma fronteira privada de compilação. A seleção foi repetida depois da última limpeza do lowering.
- Seleção conjunta de Object.assign, object rest, nomes de construtores, shorthand de classes, coerção de Error e IR: seis arquivos, 122 testes verdes, 235,71 segundos. Essa é uma seleção focada, não a suite completa.
- Runtime Rust: o novo teste de presença Symbol e os 12 testes selecionados por `cargo test ... map` passaram, sem afirmar que a seleção map inclui o teste novo. Clippy `--all-targets -- -D warnings` passou no pin 1.98.0.
- Build do workspace, TypeScript do compiler, verificação do inventário de backend libCalls, surface manifest de 667 entradas e `node-compat:check` passaram. A compatibilidade continua em 4690 linhas internas e 3662 públicas para Node 24.15.0; nenhum status positivo foi ampliado.
- ESLint do lowering novo e do teste público passou sem erros ou warnings; os arquivos antigos adicionais consultados têm warnings preexistentes de non-null assertions. `git diff --check` passou.
- Seleção sanitizada de 3381: Rust passou; C e LLVM terminaram com o erro fatal explícito de LeakSanitizer sob ptrace. A detecção de leaks não foi desligada.
- `cargo test` integral anunciou 269 testes, registrou falhas em testes de rede e terminou anormalmente no teste UDP, sem resumo agregado válido. Um TCP isolado também falhou. Esta execução não é um gate verde e os resultados não identificam individualmente a causa de todas as falhas.
- O check de tamanho dos arquivos falha em diversos arquivos do estado atual, incluindo arquivos alterados por esta etapa. Não se ampliou o teto congelado para esconder a falha. As lanes integrais plain e SAN continuam pendentes; a seleção focada não autoriza shipping.

O wrapper cgroup `pnpm limit` não funciona nesta sessão (`Failed to connect to bus: Operation not permitted`). Os testes usaram um worker Vitest, um compilador nativo e um job Cargo por processo, heap Node limitado e timeouts, sem anunciar um limite rígido de RAM substituto. A máquina tinha aproximadamente 16 GiB disponíveis na checagem inicial. Fetch/reconciliação permanece indisponível porque `.git/FETCH_HEAD` é somente leitura; WIP existente foi preservado.

## Próxima etapa

Começar por um witness permanente de Error.captureStackTrace no Node fixado, antes de mudar a API ou o inventário. O Baldim passa `this` e `this.constructor`, além de ter um fallback que lê Error.stack e um método toJSON que expõe stack. A implementação precisa resolver coerentemente captura, propriedade stack e corte por constructorOpt; remover a chamada, transformá-la em no-op ou retornar uma stack inventada não qualifica o pacote original. O compiler hoje documenta sua ausência de captura de frames no diagnóstico de Error.stack.

O primeiro aceite deve fixar os contratos realmente observáveis do alvo Error e de constructorOpt, mapear a representação de frames de origem no runtime nativo e manter recusas nomeadas para formas ainda fora da fatia implementada. Depois disso, repetir os dois builds originais e comparar stdout, stderr, status, campos do erro e identidade contra Node; diagnosticar qualquer nova recusa ou divergência que só apareça depois dessa fronteira. Só então avançar para os grafos mais amplos do pacote e para os consumidores redwall/redskilled. A consulta à documentação versionada de Node 24.15.0 pela ferramenta web falhou nesta sessão; essa consulta permanece parte obrigatória da etapa de compatibilidade, sem usar documentação de outra versão como prova do pin.

As skills de diagnóstico e TDD orientaram a minimização e os testes pela API pública, sem mocks ou contornos no consumidor. A guarda de serialização não mudou formatos de filesystem ou wire. Nenhuma inicialização de Memory/Wiki ou nova arquitetura de serviços foi feita.
