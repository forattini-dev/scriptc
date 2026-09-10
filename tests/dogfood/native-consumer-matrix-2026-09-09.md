**Matriz de compilação TS/JS → Rust nativo — 8–9 de setembro de 2026**

Esta auditoria usa os fontes atuais dos consumidores e o WIP do worktree `rust-effect-native` do scriptc. Binários de distribuição por plataforma são deduplicados pelo ponto de entrada; lançadores são separados das aplicações que iniciam. O teste é de build nativa no host Linux, sem engine JS. Não é uma avaliação de performance nem uma validação de cross-compilation.

**Escopo e método.** Foram inventariadas 43 entradas em cinco repositórios: 24 aplicações/CLIs, 18 lançadores/hooks e um smoke test. O executável `tq` do repositório TOON já é Rust e não é entrada TS do scriptc. O CLI TS vendorizado do TOON foi incluído. Sites, bibliotecas, extensões de editor, ferramentas de desenvolvimento e exemplos comuns não são binários de produto independentes. Workers embutidos do Redcode fazem parte do empacotamento da aplicação.

Cada entrada passa pela API `compile` do compilador atual, com `backend: "rust"`, `allowEngine: false`, `npmStatic: "auto"` e otimização `dev`. Redcode/Lildax e red-dev usam a superfície Bun; os demais usam Node 24. O código do compilador é carregado de `packages/compiler/src`, sem depender de um dist desatualizado. A fase de cobertura usa `analyze` em processo separado.

Cada processo roda no limitador do repositório: CPU 100% (um núcleo), memória high 2 GiB, máxima 3 GiB, sem swap e um worker Cargo. O prazo inicial é de 180 segundos por fase; a cobertura não repete builds que já atingiram esse prazo, salvo as primeiras duas tentativas. Retentativas selecionadas usam 600 segundos. Timeout é inconclusivo, não prova incompatibilidade. `build-process.json` descreve o worker; exit 0 desse processo não implica build aprovada. A autoridade é `build.json.build.ok`, combinada com engine/fences e contratos.

**Resultados por repositório.**

| Repositório | Entradas | Compilaram | Recusas | Crashes | Inconclusivos | Pendentes |
|---|---:|---:|---:|---:|---:|---:|
| red-skills | 33 | 7 | 21 | 0 | 5 | 0 |
| redcode | 5 | 1 | 1 | 1 | 2 | 0 |
| red-dev | 2 | 0 | 2 | 0 | 0 | 0 |
| toon | 2 | 0 | 2 | 0 | 0 | 0 |
| tuiuiu.js | 1 | 0 | 1 | 0 | 0 | 0 |

**O que executou.** O RPC sidecar do Redcode gerou um executável Rust com `engine: none`, `externalFfi: false`, zero runtime fences e 113 instruções analisadas sem falhas. Os oito contratos existentes passaram contra esse binário: JSON/TOON, autenticação, ordem sequencial, notificações sem resposta, limites de entrada, redirects, validação de URL e SIGTERM. Os mesmos oito contratos passaram na execução dos fontes por Bun. Isso valida esse componente; não valida o CLI principal do Redcode.

Os sete lançadores npm do RedSkills também compilaram. Para cada um, uma cópia byte a byte do fonte foi colocada ao lado do binário e executada por Node; o caso de payload ausente coincidiu em stdout, stderr e status 1. A execução do payload NÃO foi validada. Esses shims usam `spawnSync(process.execPath, [bundle, ...])`: depender de um interpretador capaz de abrir o bundle JS não equivale a compilar a aplicação. Os sete shims não contam como sete aplicações nativas.

**Separação entre consumidor e compilador.**

- Consumidor/ambiente: instalar as dependências e declarações de tipos; o checkout local do Tuiuiu não tem seu TypeScript instalado. O Tuiuiu foi localizado em `/home/cyber/Work/tetis/libs/tuiuiu.js` (v1.0.69), enquanto red-dev usa a dependência v1.0.75; os dois casos não foram confundidos. O CLI vendorizado do TOON não resolve `citty` e outras dependências e seu tsconfig não habilita `strictNullChecks`, requisito documentado do scriptc. Apontar a build para o fonte real da aplicação; um lançador que exige um interpretador de JS não substitui essa entrada. Preservar/reproduzir defines e assets de empacotamento quando forem necessários.
- Compilador/runtime: suporte a `node:process`, funções com rest como valores, compatibilidade de aridade de callbacks, imports dinâmicos estaticamente resolvíveis, inferência/representação de contêineres, APIs Bun e admissão estática de dependências. Não recomendar casts, clones ou remoção de semântica para esconder essas limitações.
- Robustez do frontend: `packages/redcode/bin/redcode`, um arquivo JS com shebang e sem extensão, provoca panic do TypeScript Go (`ScriptKind must be specified`), seguido de EOF no RPC. O problema ocorreu nas duas fases. Além disso, o benchmark-memory reportou quatro SC0004 em consultas do checker envolvendo TypeReference/TupleType; são panics capturados como diagnósticos, distintos do crash sem extensão. O compilador deve definir a linguagem ou devolver diagnóstico controlado, em vez de derrubar o parser.

**Controles e prioridades.**

- RSP: 247 diagnósticos, 69 runtime fences, 3382 instruções, 284 falhas e quatro instruções island. São ocorrências, com cascatas; não representam 247 correções independentes.
- MCP do RSP: quatro diagnósticos e seis fences em 329 instruções. Próximos casos concretos: aridade de callbacks, retorno de função em união, teste typeof contra string variável, `Number.toString(radix)`, escrita em objetos dinâmicos, spread de array dinâmico e flatMap com resultado dinâmico. Uma correção pode revelar novas barreiras.
- red-dev: 774 diagnósticos, 4583 instruções e 726 falhas. Os grupos maiores incluem 238 restrições de rest e 295 usos contaminados por declarações já recusadas. APIs Bun sem lowering e dependências não admitidas estaticamente também bloqueiam a aplicação.
- Tuiuiu: o checkout original produz 80 diagnósticos (79 de tipos, um import). O TypeScript 5.9, usando externamente os tipos Node 24 do worktree do compilador, passou sem editar o consumidor. Uma cópia de fontes/configurações idênticos, com essas dependências disponíveis, reduz a recusa inicial da build a `node:process`. Essa comparação distingue instalação/fallback de tipos e implementação de API. Não significa que o restante da aplicação já compila: a análise ampliada dessa cópia atingiu o prazo de 180 segundos.

**Inventário executado.** Os números de diagnósticos são da tentativa de build; fences são da cobertura, quando disponível. Um traço significa que a fase não forneceu esse dado.

| Repositório / entrada | Tipo | Build | Diagnósticos | Fences na cobertura | Evidência |
|---|---|---|---:|---:|---|
| red-skills / dev | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-dev) |
| red-skills / castle-mcp | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-castle-mcp) |
| red-skills / code-nav | aplicação | Recusado | 17 | 20 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-code-nav) |
| red-skills / brain | aplicação | Recusado | 47 | 20 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-brain) |
| red-skills / brain-mcp | aplicação | Recusado | 27 | 20 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-brain-mcp) |
| red-skills / memory | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-memory) |
| red-skills / memory-mcp | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-memory-mcp) |
| red-skills / rsp | aplicação | Recusado | 247 | 69 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-rsp) |
| red-skills / rsp-mcp | aplicação | Recusado | 4 | 6 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-rsp-mcp) |
| red-skills / redskilled | aplicação | Recusado | 28 | 71 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-redskilled) |
| red-skills / red-browser | aplicação | Recusado | 15 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-red-browser) |
| red-skills / benchmark-memory | aplicação | Recusado | 228 | 31 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-benchmark-memory) |
| red-skills / benchmark-code-understanding | aplicação | Recusado | 11 | 17 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-benchmark-code-understanding) |
| red-skills / rsp-benchmark | aplicação | Recusado | 29 | 20 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-rsp-benchmark) |
| red-skills / opencode-host | aplicação | Recusado | 11 | 20 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-opencode-host) |
| red-skills / herdr | aplicação | Recusado | 2 | 106 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-herdr) |
| red-skills / red-castle | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-red-castle) |
| red-skills / red-castle-mcp | aplicação | Recusado | 45 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-red-castle-mcp) |
| red-skills / entrypoint | lançador | Recusado | 7 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-entrypoint) |
| red-skills / afk-container | lançador | Recusado | 18 | 18 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-afk-container) |
| red-skills / red-fetch | lançador | Recusado | 2 | 31 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-red-fetch) |
| red-skills / afk | lançador | Recusado | 2 | 31 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-afk) |
| red-skills / pi-afk | lançador | Recusado | 2 | 31 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-pi-afk) |
| red-skills / codex-statusline | lançador | Recusado | 6 | 6 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-codex-statusline) |
| red-skills / brain-bootstrap | lançador | Recusado | 8 | 8 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-brain-bootstrap) |
| red-skills / memory-bootstrap | lançador | Recusado | 3 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-memory-bootstrap) |
| red-skills / npm-red-skills-brain | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-red-skills-brain) |
| red-skills / npm-red-skills-castle-mcp | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-red-skills-castle-mcp) |
| red-skills / npm-red-skills-code-nav | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-red-skills-code-nav) |
| red-skills / npm-red-skills-dev | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-red-skills-dev) |
| red-skills / npm-red-skills-memory | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-red-skills-memory) |
| red-skills / npm-red-skills-redskilled | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-red-skills-redskilled) |
| red-skills / npm-rsp | lançador | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-skills-npm-rsp) |
| redcode / redcode | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/redcode-redcode) |
| redcode / lildax | aplicação | Inconclusivo: prazo | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/redcode-lildax) |
| redcode / rpc-sidecar | aplicação | Compilou | 0 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/redcode-rpc-sidecar) |
| redcode / redcode-launcher | lançador | Crash do frontend | — | — | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/redcode-redcode-launcher) |
| redcode / lildax-launcher | lançador | Recusado | 3 | 3 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/redcode-lildax-launcher) |
| red-dev / red-dev | aplicação | Recusado | 774 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-dev-red-dev) |
| red-dev / tui-smoke | smoke | Recusado | 4 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/red-dev-tui-smoke) |
| toon / toon-cli | aplicação | Recusado | 20 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/toon-toon-cli) |
| toon / toon-launcher | lançador | Recusado | 1 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/toon-toon-launcher) |
| tuiuiu.js / tuiuiu | aplicação | Recusado | 80 | 0 | [fontes/resultados](/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908/tuiuiu.js-tuiuiu) |

**Reprodução e limites da evidência.**

O diretório de evidências é `/home/cyber/Work/reddb.io/scriptc/.red/tmp/worktrees/manual/rust-effect-native/.red/tmp/native-consumer-matrix-20260908`. `inventory.json` registra manifests, entradas e exclusões; `worker.mts` invoca a API; `run.py` executa processos limitados; `summary.json` conserva resultados por alvo; cada diretório contém builds, cobertura, hashes de fontes e logs. `before.json` registra revisões/WIP e hashes do compilador. `consumer-source-hashes.json` registra os fontes/configurações dos consumidores. As verificações finais de integridade ficam em `integrity.json`.

Os testes não alteram fontes dos consumidores. Redcode e red-dev já tinham WIP no começo; alterações concorrentes, se houver, aparecem na verificação final. O compilador também está em WIP, incluindo uma migração UTF-16 ainda não encerrada. O gate completo plain/sanitized do repositório não foi executado nesta auditoria de consumidores; os resultados não autorizam afirmar ausência de regressões, prontidão para release, superioridade sobre C/LLVM ou sucesso dos projetos completos.

**Retentativas e flags.**

| Entrada | Modo | Resultado | Prazo | Diagnósticos |
|---|---|---|---:|---:|
| red-skills-dev | npm-static auto (retentativa) | Inconclusivo: prazo | 600 s | — |
| redcode-redcode | npm-static auto (retentativa) | Inconclusivo: prazo | 600 s | — |
| red-skills-dev | sem npm-static auto (controle) | Recusado | 90 s | 1 |
| red-skills-castle-mcp | sem npm-static auto (controle) | Recusado | 90 s | 238 |
| red-skills-memory | sem npm-static auto (controle) | Recusado | 90 s | 56 |
| red-skills-memory-mcp | sem npm-static auto (controle) | Recusado | 90 s | 654 |
| redcode-redcode | sem npm-static auto (controle) | Inconclusivo: prazo | 90 s | — |
| redcode-lildax | sem npm-static auto (controle) | Inconclusivo: prazo | 90 s | — |

Os controles sem auto não produziram executáveis. O dev parou em declaração ausente de js-yaml; memory encontrou reexports/ciclos; castle-mcp e memory-mcp expuseram dependências dinâmicas e limitações de lowering. Redcode e Lildax também atingiram o prazo de 90 segundos nesse controle. As configurações percorrem fronteiras diferentes e param em lugares diferentes: esses tempos não são um benchmark isolado do custo da flag.

As retentativas com auto de red-skills-dev e Redcode atingiram 600 segundos. No Redcode, o processo principal saiu com status 124, mas restou um processo TS7 no cgroup durante o encerramento. Ele foi finalizado após verificar que pertencia exclusivamente ao teste; o registro está em extended/redcode-redcode/timeout-cleanup.txt.

**Integridade final.**

Não houve alterações nos arquivos do compilador durante os testes, nem diferenças nos hashes dos binários gerados. Uma edição concorrente em src/console-ownership.test.ts alterou o status Git do red-dev; não foi feita por esta auditoria. Os demais quatro estados Git permaneceram iguais. Os snapshots de fontes/configurações verificados permaneceram iguais.

Três textos retornados pelo frontend diferem dos arquivos npm em disco por comentários @typedef virtuais acrescentados à memória (cli-args-parser, TOON e SDK). As três diferenças foram reproduzidas, preservando exatamente o prefixo de bytes original e os hashes dos textos analisados; source-views/comparison.json e os pares de arquivos documentam a distinção. Não são edições dos consumidores.

**Complemento de escopo: Redwall.** O executável `red-dev/vendor/redwall-bin/redwall` e seu renderer separado ficaram fora das 43 entradas acima. O complemento em [redwall-native.md](./redwall-native.md) acrescenta esse alvo, levando o inventário conhecido a 44 entradas. O artefato existente tem 1,87 MB e engine JS; o teste do renderer original com Rust sem engine foi recusado em duas chamadas de Date por componentes. Os totais acima conservam a execução histórica; não contam esse complemento como build Rust aprovada.
