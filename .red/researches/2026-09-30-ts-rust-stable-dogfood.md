# TS → Rust estável: estado comprovado, lacunas e roteiro de qualidade

Data: 2026-09-30, com execuções concluídas na madrugada UTC de 2026-10-01, ainda 2026-09-30 em America/Sao_Paulo.

Consulta: “Não quero nightly build; quero garantir o melhor TS → Rust compiler possível. Levantamento extremamente detalhado do que falta, testando redwall, plugins e daemon.”

Escopo do levantamento inicial: inspeção do compilador atual e de consumidores reais, pesquisa em documentação primária e sondagens locais com Rust estável, sem engine JavaScript. Durante esse levantamento não houve implementação de correções, mudança nos consumidores, lançamento do daemon, provisionamento, publicação ou alteração de compatibilidade gerada. O trabalho experimental de sanitização que já existia foi preservado, mas não é requisito deste roteiro.

Atualização posterior ao levantamento: a primeira correção de ordem por instância foi implementada e registrada no [checkpoint do backend Rust](../code/plans/2026-09-30-record-instance-order-checkpoint.md). Dez programas do corpus e os seis casos do parser real do red-dev passaram na comparação byte a byte por arquivos; os gates completos continuam bloqueados. As seções abaixo preservam o baseline anterior à correção e não representam o estado pós-correção.

Atualização em 2026-10-01: a separação entre tipos e execução e a distinção de imports inline Node/Bun foram implementadas no [novo checkpoint](../code/plans/2026-10-01-type-runtime-graph-checkpoint.md). Passaram 64 testes focados e 18 testes de execução selecionados no harness oficial. O renderer perdeu a recusa de runtime espúria, mas mantém um erro real de tipos no import tuiuiu.js/red-dev; as duas lanes amplas encontram uma recusa Rust em spread de record com await. O levantamento abaixo continua sendo histórico, não uma declaração de gates verdes.

Atualização seguinte em 2026-10-01: o bloqueio de await em objetos ordenados foi corrigido no [checkpoint de suspensão assíncrona](../code/plans/2026-10-01-async-ordered-record-checkpoint.md). A regressão original e o novo corpus passaram contra Node; a seleção ampliada terminou com 128 testes passando e oito falhas, e ambas as lanes completas pararam no aviso ESM de uma fixture temporária. A dependência do redwall foi reavaliada e ainda produz SC0001.

Atualização mais recente em 2026-10-01: o [checkpoint de reconciliação](../code/plans/2026-10-01-async-sequence-record-reconciliation.md) registra a correção dos avisos de fixtures, do crash de chave computada, de sequências de spread com await nos caminhos simples e protegido e da construção dos records de processo no Rust. Oito falhas de programas foram reproduzidas nas fontes do HEAD; duas foram corrigidas e seis permanecem como backlog confirmado. A seleção ampliada passou 108 testes e encontrou duas falhas adicionais, depois corrigidas numa seleção de nove testes verdes. O runtime também passou 268 testes e Clippy no pin 1.98.0 estável. As novas lanes completas terminaram vermelhas: a plain encontrou timeout num teste agrupado que passa isoladamente; a sanitizada passou os 108 testes do arquivo principal da API Rust, mas parou num vazamento de 156 bytes do contrato C/LLVM multi-instance, também reproduzido nas fontes do HEAD. Os resultados focados não substituem as duas lanes completas. O levantamento abaixo preserva a baseline histórica.

## Resumo executivo

O próximo passo mais valioso é corrigir divergências semânticas comprovadas antes de aumentar o número de APIs aceitas. Esta investigação gerou sete executáveis Rust em toolchain estável, incluindo componentes originais do red-dev e red-skills, e encontrou uma divergência de ordem de propriedades que afeta tanto `Object.keys` quanto `JSON.stringify`. Também encontrou uma recusa de `Array.from(Uint8Array)`, uma recusa de runtime em dependência alcançada apenas por importação de tipo e uma lacuna importante de validação: o runner atual de Test262 não admite backend Rust.

Quatro componentes têm evidência positiva limitada aos contratos executados: statusline do daemon, guard de resource lease, hash do Brain e hash do Memory. O parser de CLI compila, mas sua serialização não tem paridade byte a byte. O codec PNG compila e preserva o raster do wallpaper 4K testado, mas não reproduz os bytes comprimidos do Node. O renderer completo executa sob Node sem Tuiuiu instalado, porém o preflight do compilador exige essa dependência por caminhos de tipos. Os aplicativos completos não têm baseline válido de compilação nesta máquina porque seus workspaces estão sem dependências instaladas.

A recomendação é manter o contrato TS-first → IR validada → Rust sem engine, estabelecendo gates explícitos de correção, robustez, memória, consumidores reais e performance. Nightly não pertence à trilha principal. “Melhor possível” precisa significar comportamento preservado e resultados reproduzíveis sobre um escopo definido, não uma porcentagem agregada inventada nem aceitação silenciosa de programas incompatíveis.

## Fontes oficiais e primárias

- [Guia do repositório](../../AGENTS.md), [contrato aprovado TS-native](2026-09-13-typescript-native-core/README.md) e [plano anterior](../code/plans/2026-09-30-estado-e-proximos-passos.md): política local, escopo e intenção; o plano anterior contém pendências históricas que precisam de reconciliação com o código atual.
- [Código do frontend](../../packages/compiler/src/frontend/program.ts), [lowering de Array.from](../../packages/compiler/src/frontend/lowering/lower-array-from.ts), [type mapper](../../packages/compiler/src/frontend/type-mapper.ts), [IR](../../packages/compiler/src/ir/ir.ts), [validador](../../packages/compiler/src/ir/validate.ts) e [driver Rust](../../packages/compiler/src/backend/rust/compile.ts): implementação atual, não garantia automática de comportamento.
- [Harness desta investigação](../tmp/ts-rust-stable-audit-20260930/probe.mjs), [contratos executáveis](../tmp/ts-rust-stable-audit-20260930/contracts.sh) e [resultados diferenciais](../tmp/ts-rust-stable-audit-20260930/contracts.jsonl): evidência local fresca; scratch não substitui regressões permanentes no corpus.
- [Node.js 24.15.0](https://nodejs.org/download/release/v24.15.0/docs/api/) e [node:zlib](https://nodejs.org/download/release/v24.15.0/docs/api/zlib.html): versão do oráculo e referência das APIs.
- [TypeScript: imports exclusivamente de tipos](https://www.typescriptlang.org/docs/handbook/modules/reference.html#type-only-imports-and-exports) e [compatibilidade de tipos](https://www.typescriptlang.org/docs/handbook/type-compatibility.html): separação entre tipos e execução e regras estruturais do idioma de origem.
- [Rust: ownership](https://doc.rust-lang.org/book/ch04-01-what-is-ownership.html): modelo de memória do destino; não demonstra equivalência semântica do programa TS.
- [ECMAScript: Array.from](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-array.from): algoritmo oficial consultado no working draft; não altera o baseline ECMAScript 2025 aprovado pelo projeto. A página da edição 2025 tentada não abriu nesta sessão.
- [Registro interno Node](../../internal/compatibility/generated/node-v24-backlog.json), [expectativas Test262](../../tests/test262/expectations.json), [runner Test262](../../tests/test262/run.ts) e [configuração de testes](../../vitest.config.ts): inventários e fronteiras de validação atuais.
- [Redwall histórico](../../tests/dogfood/redwall-native.md) e [matriz histórica de consumidores](../../tests/dogfood/native-consumer-matrix-2026-09-09.md): evidências anteriores, explicitamente não revalidadas como resultados atuais.

## Hotlinks: comece por aqui

- [Contraexemplo mínimo de ordem de propriedades](../tmp/ts-rust-stable-audit-20260930/property-order.ts).
- [Saída Node do contraexemplo](../tmp/ts-rust-stable-audit-20260930/contracts/property-order.node.stdout) e [saída Rust](../tmp/ts-rust-stable-audit-20260930/contracts/property-order.rust.stdout).
- [Recusa de Array.from em target Node](../tmp/ts-rust-stable-audit-20260930/results/array-from-bytes-node24/probe.json) e [target Bun](../tmp/ts-rust-stable-audit-20260930/results/array-from-bytes-bun/probe.json).
- [Recusa da dependência exclusivamente de tipo, já sem erro de tipagem](../tmp/ts-rust-stable-audit-20260930/results/typeonly-ambient/probe.json).
- [Metadados de aceitação do PNG](../tmp/ts-rust-stable-audit-20260930/results/redwall-png/probe.json) e [statusline](../tmp/ts-rust-stable-audit-20260930/results/statusline/probe.json).
- [Clippy estável](../tmp/ts-rust-stable-audit-20260930/runtime-clippy.log), [tentativa do gate runtime](../tmp/ts-rust-stable-audit-20260930/runtime-tests.log) e [restrições do ambiente](../tmp/ts-rust-stable-audit-20260930/environment-probes.log).

## 1. Baseline e método

O checkout scriptc está em `ba5d2a222270b86bad78883260e92ab9d717b445`, com WIP anterior preservado. Consumidores: red-dev em `b715031ce6fbe07ae085a451d2a4bfc47b1dc077` e red-skills em `b1ed1432cf3fa9c43efef6e43da79f8fbe5995b1`; esses hashes não afirmam que os worktrees estejam limpos. `../redskilled` não existe: o daemon encontrado está em `../red-skills/apps/redskilled`.

Toolchain efetivamente usada: `rustc 1.98.1 (48a229cea 2026-09-01)`, host `x86_64-unknown-linux-gnu`, Cargo offline, um job Cargo e um slot de compilação nativa. O crate fixa seu próprio gate em Rust 1.98.0, que não está instalado; portanto Clippy 1.98.1 aprovado não é prova de execução no pin exato. `Cargo.toml` declara edition 2024 e MSRV 1.88; o MSRV não foi testado. O pacote compiler declara TypeScript 7.0.2; o tooling da raiz também tem TypeScript 5.9.3, distinção importante para não medir o checker errado.

As sondagens chamaram a API diretamente do fonte atual, via Node 24.15.0 + tsx, com `backend: rust`, `allowEngine: false`, `sanitize: false` e `optimization: release` nos builds nativos. Não usaram `dist` possivelmente desatualizado. Os sete artefatos aceitos reportam `engine: none`, `externalFfi: false` e zero runtime fences; suas unidades Rust começam com `#![forbid(unsafe_code)]`. Isso não equivale a declarar todas as dependências transitivas livres de unsafe ou C.

Fixtures de kernels importam as funções dos arquivos originais por caminho relativo e usam tsconfig controlado no scratch, com tipos Node disponíveis no scriptc. Isso mede componentes reais, mas não o build de distribuição completo dos consumidores. A statusline é a exceção explícita: o arquivo de entrada contém a string canônica exportada por `statusline-native-source.ts`; comparação fresca confirmou igualdade exata dos textos. O logging do fixture PNG usa loop em vez de `Array.from`; o código original do codec não foi modificado e a forma recusada permanece em witness separado.

As execuções diferenciais foram feitas pelo shell, registrando stdout, stderr, status e artefatos. Os binários Rust receberam `SCRIPTC_RUST_HEAP_AUDIT=1`. Os casos de statusline rodaram em diretórios isolados, sem ler o cache operacional do projeto. Não se executou `serve`, nascimento de Workers, rescue efetivo, escrita em Brain/Memory nem configuração de wallpaper. `rescue --apply` foi somente uma string passada ao parser puro.

Na leitura atual de memória havia cerca de 17 GiB disponíveis e zero uso de swap: não há evidência de RAM tomada neste momento. O limiter via user cgroup não está operacional neste ambiente; os jobs foram limitados manualmente. Tempos de compilação dos seis primeiros kernels ficaram aproximadamente entre 9 e 16 segundos, mas não constituem benchmark controlado. `peakRssKiB` nos probes mede somente o processo Node do compilador, não soma Go/TS7, Cargo e rustc; não deve ser publicado como pico total de memória da compilação.

## 2. Resultados novos: binários realmente gerados e executados

| Componente | Build Rust estável, sem engine | Execução testada | Resultado limitado à evidência |
| --- | --- | --- | --- |
| statusline-fast do redskilled | Sim | Cinco contratos: payload válido, JSON inválido, stdin vazio, cache com newline e cache só de espaços | stdout/stderr/status idênticos; auditoria de heap silenciosa |
| guard `isRedskilledResourceLease` | Sim | null, array, objeto vazio, lease válida, ID vazio | Cinco valores booleanos idênticos; não testa aquisição, renovação ou concorrência |
| hash do Brain | Sim | SHA-256, slug com Unicode e content hash de valores mistos | stdout/stderr/status idênticos para as entradas escolhidas |
| hash do Memory | Sim | argumentos opcionais/rest, vazio e comportamento de concatenação | stdout/stderr/status idênticos; não testa armazenamento ou MCP |
| parser de CLI red-dev | Sim | Seis invocações de parsing, inclusive erro e `rescue --apply` | Status 0 e valores iguais, mas JSON tem ordem de chaves diferente; não passa gate byte a byte |
| codec PNG redwall | Sim | Raster 4×3 e decode/reencode de obsidian 3840×2160 | stdout/stderr/status iguais e raster igual; arquivo PNG comprimido diferente do Node |
| witness de ordem de propriedades | Sim | Retorno de função, `Object.keys` e spread | Divergência semântica reproduzida independentemente do parser |

O resumo atualizado tem onze contratos: oito com paridade e três sem paridade, contando o witness de ordem, o parser e o artefato PNG. Essa contagem não representa cobertura do compilador. Statusline é um componente nativo real, mas continua sendo a frente rápida de um sistema cujo renderer pesado é outro programa: não demonstra que o daemon inteiro ou seu renderer pesado já seja nativo.

### 2.1 Divergência prioritária: ordem observável de propriedades

Witness compilado:

```ts
function choose(reverse: boolean): { a: number; b: number } {
  if (reverse) return { b: 2, a: 1 };
  return { a: 1, b: 2 };
}
console.log(JSON.stringify(choose(false)));
console.log(JSON.stringify(choose(true)));
console.log(Object.keys(choose(true)).join(","));
console.log(JSON.stringify({ ...choose(true), c: 3 }));
```

Node imprime `{"a":1,"b":2}`, `{"b":2,"a":1}`, `b,a` e `{"b":2,"a":1,"c":3}`. Rust imprime `{"a":1,"b":2}`, `{"a":1,"b":2}`, `a,b` e `{"a":1,"b":2,"c":3}`. Ambos saem com status 0 e stderr vazio. No parser real, todas as seis serializações divergem em ordem, embora a comparação dos valores após parse e ordenação das chaves confirme igualdade.

Conclusão comprovada: a ordem de criação é perdida nesse caminho de records tipados. A localização causal exata — layout canônico, conversão na fronteira da função, ou emissão da enumeração — ainda exige instrumentação da IR e Rust emitidos. Não é apenas um problema cosmético de JSON: `Object.keys` também muda, e isso pode atingir hashes, assinaturas, snapshots e protocolos. Não se deve “corrigir” o teste ordenando o objeto no consumidor.

Aceite da correção: preservar ordem efetiva de inserção sem depender da ordem estrutural do tipo; cobrir literais com ordens diferentes, retorno/parâmetro de função, spread, atribuição posterior, delete/reinserção, chaves numéricas, opcionais ausentes e conversões static↔dyn. Se alguma forma ainda não puder ser representada fielmente, a alternativa segura é recusa explícita e estreita, não comportamento silenciosamente diferente. Essas extensões são requisitos propostos, não bugs todos já reproduzidos.

### 2.2 Recusa reproduzida: Array.from de bytes

`Array.from(new Uint8Array([1, 2, 255])).join(",")` executa sob Node e imprime `1,2,255`, mas recebe SC2020 em ambos os targets testados, Node24 e Bun. O hint lista arrays, tuples, strings, Set/Map e alguns iteradores imediatos, mas não TypedArray. Isso isola a lacuna no lowering/admissão, antes do backend Rust; não depende de retorno de outro módulo.

Primeira família proposta: TypedArray/Buffer → materialização de array, com e sem mapper, entrada vazia, offsets/views, signed/unsigned e efeitos do mapper sobre a origem. A extensão deve preservar a ordem das leituras e callbacks; copiar a origem inteira antes do mapper pode esconder mutações observáveis. Iteradores arbitrários, `thisArg` e fechamento de iterator formam etapas seguintes separadas, não requisitos que precisam atrasar o primeiro suporte coerente.

### 2.3 Type-only graph: recusa desnecessária de runtime

O renderer atual importa tipos de arquivos que, transitivamente, importam `tuiuiu.js/red-dev`. O compilador retorna SC0001 e SC1010 na dependência ausente; o mesmo fixture renderer executou sob Node, sem essa dependência, produzindo um PNG de 115.500 bytes. Isso mostra que ela não é necessária para executar esse caminho, mas a ausência continua podendo afetar o checker de tipos do workspace completo.

O witness mínimo importa somente um tipo de um arquivo que contém import de runtime inexistente. Inicialmente também havia erro de tipo. Após adicionar uma declaração ambient válida para esse módulo, SC0001 desapareceu e restou SC1010 no arquivo alcançado somente por tipo; Node segue executando sem carregar o módulo. O frontend já ignora a declaração `import type` ao criar edges, mas seus loops de preflight visitam a coleção mais ampla `userFiles`. A provável origem é a diferença entre universo do checker e grafo de execução, não ausência total de suporte a `import type`.

Aceite proposto: manter os arquivos necessários ao checker, mas aplicar recusas de runtime, inicialização e efeitos apenas ao grafo de valores efetivamente executável, incluindo reexports, imports mistos, JSDoc, aliases e módulos que também tenham um caminho de valor. Não ignorar erros reais de TypeScript nem transformar qualquer arquivo “não usado” em isenção indiscriminada. Instalar dependências do consumidor continua sendo necessário para avaliar o aplicativo integral.

### 2.4 PNG: equivalência de pixels não é equivalência de bytes

O wallpaper reencodificado tem 97.710 bytes no Node, 95.469 bytes no Rust e 91.696 bytes no Bun 1.4.2. Todos os três decodificam para o mesmo raster 3840×2160, com SHA-256 dos bytes RGBA `ad037be476132d1a68cf2aaf74fe36bb3a21e7cb9524783967bee5078add1f0f`. Os headers zlib observados são `789c` em Node/Rust e `78da` em Bun; o codec original seleciona level padrão no Node e level 9 no Bun.

Isso comprova diferença de stream comprimido, não pixels incorretos. O runtime usa flate2 com zlib-rs; a hipótese de algoritmo/versão de compressão precisa ser isolada em um witness de `deflateSync` com opções explícitas. Não concluir que o binário executou o branch Bun só porque os bytes diferem: os headers são compatíveis com o branch Node.

Aceite precisa explicitar dois contratos diferentes: equivalência do conteúdo decodificado e reprodução de bytes do oráculo fixado. Não ampliar `supported` com base só no primeiro. Se a política exigir identidade dos streams para o workload, há trabalho real de compatibilidade da implementação de compressão; se aceitar streams diferentes válidos, registrar essa exceção pontual antes de qualificar o renderer, sem relaxar a paridade semântica de JSON, stdout ou status. A decisão de produto ainda não foi tomada.

## 3. Aplicativos completos: o que não se pode concluir

| Entrada original | Diagnósticos desta tentativa de emissão | Bloqueio principal observado |
| --- | ---: | --- |
| red-dev main | 81 | Tuiuiu não instalado, tipos Node/Bun e efeitos em cascata |
| redskilled CLI | 563 | Packages de workspace `@reddb-io/*` não resolvidos; tipos ambient incompletos; outras recusas misturadas |
| plugin-brain CLI | 68 | Packages de workspace não resolvidos, tipos e imports consequentes |
| plugin-memory CLI | 182 | Packages ausentes, tipos ambient e recusas/ciclos que precisam ser reavaliados com instalação válida |
| plugin-dev MCP server | 391 | Packages de workspace/SDK não resolvidos; tipos em cascata |

São resultados de preflight/source emission, não de execução nativa nem uma lista de 1.285 features faltantes. Ausência de `copyFile` na superfície ambient de `node:fs/promises`, por exemplo, pede separar resolução das declarações, modelagem do builtin e implementação do runtime. Os SDKs, exports e build defines precisam estar materializados antes de classificar essas aplicações. Nenhum node_modules foi instalado ou linkado nos vizinhos nesta investigação.

Para uma baseline válida, preparar uma lane descartável com a mesma revisão do consumidor, instalação congelada, package exports originais e build defines originais; executar primeiro seus checks próprios; só então analisar/compilar com Rust sem engine. Não “resolver” o consumidor integral substituindo fontes, removendo imports, introduzindo casts ou criando launchers que executam Node/Bun. O roteiro pode tratar integrações nativas explícitas como decisões arquiteturais, mas não contabilizá-las como lowering de TS ainda inexistente.

## 4. Validação: trabalho estrutural necessário

### 4.1 Gates estáveis e ambiente de execução

Clippy `--all-targets -- -D warnings` passou nesta rodada com Rust 1.98.1. A tentativa de `cargo test --lib` anunciou 268 testes, registrou falhas em casos de rede e terminou anormalmente sem resultado agregado válido; portanto o gate não está verde. Uma repetição isolada de TCP também falhou. Probes independentes do ambiente confirmaram `spawnSync('/bin/true') → EPERM` e bind/listen de loopback → EPERM. A restrição de rede é compatível com as falhas observadas, mas não prova individualmente a causa de todas as falhas do runtime, cujos detalhes não apareceram no log.

Próximo aceite: rodar o crate no pin estável exato, com sockets/processos permitidos, e obter resumo integral verde. Rodar full plain e a lane sanitizada exigida pelo repositório no ambiente correto antes de shipping. `SCRIPTC_SAN=1` tradicional não prova que Rust foi sanitizado; não misturar a lane C/LLVM com a experiência ASan Rust. O protótipo Rust-ASan não deve ser o caminho crítico nem condição para compilar o produto, pois o maintainer rejeitou dependência de nightly.

Ações: conferir matriz suportada de host/toolchain; alinhar o pin estável deliberadamente; criar gate Rust explícito com zero skips silenciosos; classificar EPERM/EROFS/toolchain ausente como erro de ambiente; conservar a regra de gates full antes de shipping. Não alterar testes para esconder as restrições da sessão atual. O MSRV 1.88 precisa de gate próprio ou de revisão do contrato, não pode ser inferido do build 1.98.1.

### 4.2 Test262 precisa de lane Rust

`tests/test262/run.ts` aceita apenas `default`, `llvm` e `c`; `execute.ts` tipa a mesma união. O perfil seleciona scripts strict, positivos e síncronos com adapter escalar. Testes de módulos, async, negativos, agentes e várias formas de identidade/sparse arrays estão excluídos por capacidade do runner. Nada disso mede automaticamente Rust.

O arquivo de expectativas atual tem 49 recusas registradas: 31 SC2020, cinco SC1090 e treze SC0004. Esse é um inventário de expectativas, não uma execução fresca nem “49 defeitos independentes”. O default Vitest exclui `tests/harness/test262.test.ts` e seu comentário registra dez bugs conhecidos da baseline de setembro; o README Test262 ainda afirma inclusão no gate comum, uma contradição documental a reconciliar. Não se executou uma nova survey Test262 nesta investigação.

Aceite da primeira etapa: runner aceitar `--backend rust`, registrar o backend efetivo e impedir fallback; rodar o perfil adaptado existente em Rust estável com relatório por caso; manter refusals, build errors, crashes, timeouts e falhas de assertion separados; capturar os SC0004 com stack/entrada minimizada e nunca tratá-los como conclusão semântica satisfatória. Depois, ampliar perfis de identidade/holes, módulos, async e negativos com adapters que não produzam falsos positivos. Não anunciar conformidade ECMAScript inteira a partir desse perfil limitado.

### 4.3 Diferencial e fuzzing orientados a semântica

Prioridade proposta: acrescentar um caso permanente por witness novo no corpus e expandir por famílias. Uma feature precisa de caso feliz, erro, efeitos e fronteiras. Testes unitários da IR/emissor são necessários, mas não substituem execução Node versus binário Rust com comparação de stdout, stderr e status.

Famílias a auditar, sem afirmar que todas estão quebradas: coerções de Number/String/Boolean/BigInt; NaN, -0 e limites inteiros; UTF-16 e substituições regex; holes versus undefined; opcionais ausentes versus presentes; ordem e identidade de records/arrays/functions; receiver e `this`; defaults/rest; getters e efeitos avaliados uma vez; throw/catch/finally; suspensão de generators/async; filas Promise/nextTick/timers; serialização e erros nos limites de módulos/bibliotecas.

Criar geradores pequenos de TS válido, com seeds fixas, limites de recurso e minimização automática. Comparar dev/release e diferentes rotas de representação. O fuzzer deve registrar explicitamente recusa segura versus wrong-code; sucesso com output divergente é mais grave que recusa. Toda correção do reducer vira corpus permanente. Metamorphic tests úteis: refatorar literal em função, passar por parâmetro, trocar uma expressão por variável, aplicar spread e reordenar campos do tipo sem mudar a criação do objeto.

## 5. Frentes de implementação recomendadas

Estas são propostas de trabalho futuro, não alterações implementadas nesta sessão. Cada frente deve fechar uma família coerente, com evidência, e não um ticket por linha do inventário.

### P0-A — preservar semântica de objetos e conversões na IR

Entrada concreta: witness `property-order.ts` e parser red-dev. Inspecionar IR antes/depois da conversão de retorno e Rust emitido; localizar quando desaparece a ordem. Auditar `type-mapper.ts`, lowering de object literals/spread, layouts de records, JSON/Object.keys e fronteiras static↔dyn. Preferir invariantes explícitas sobre presença, identidade, ordem e efeitos em vez de remendos particulares no writer JSON.

Entregas: corpus mínimo, decisão de representação de ordem, implementação da menor família fiel, validador de IR que impeça a conversão incorreta quando verificável, testes unitários e diferencial do parser novamente. Esse é o primeiro slice de implementação recomendado porque muda comportamento de um programa já aceito.

### P0-B — grafo de execução separado do grafo de tipos

Entrada concreta: type-only witness e redwall renderer. Preservar o universo de tipos requerido pelo TS7; calcular alcançabilidade de valores com semantics de módulos; filtrar recusas de runtime sem suprimir erros de tipos. Cobrir import type, exports type, bindings mistos, reexports, aliases, npm-static e ciclos com um caminho runtime real.

Entregas: witness aceito sem carregar o módulo ambient, fixture renderer sem dependência runtime espúria, testes de controle onde o import de valor continua recusado, e medição de custo da análise. Isso também melhora o diagnóstico dos workspaces grandes, mas não dispensa instalar dependências necessárias ao checker.

### P0-C — confiabilidade da trilha Rust de validação

Entrada concreta: Test262 sem Rust, gates bloqueados por sandbox e pin não instalado. Criar artefatos de validação por backend/toolchain/features e um ambiente que rode os contratos relevantes. Tratar checker panic como defeito de robustez e distinguir falha de infraestrutura de incompatibilidade do programa.

Entregas: lane stable explícita, relatório Test262 Rust inicial, runtime gate integral no pin, regressões dos witnesses e gate full plain/sanitized previsto pelas regras. Sanitização Rust com nightly permanece fora da prioridade principal; auditoria de heap, limites, stress e verificações da linguagem Rust seguem disponíveis na lane estável.

### P1-A — contêineres, bytes e iteradores em famílias completas

Começar com `Array.from(TypedArray/Buffer)`; depois views/offsets/aliasing, materialização com mapper e adapters Iterator. Validar que copiar, emprestar e converter não muda mutação observável. Cobrir fechamento de iterator ao sair com break/throw, comportamento de bounds e tipos de elemento sem forçar boxing desnecessário.

Entregas: corpus por forma admitida, recusas estreitas para formas restantes e extensão do lowering compartilhado com evidência específica do backend Rust. Não chamar a família inteira de supported após um overload feliz.

### P1-B — caminho nativo útil para os consumidores

Redwall: liberar o renderer original, executar contratos de estado/calendário/temas/TTF/assets e PNGs reais, distinguir equivalência de raster e bytes, depois medir performance. A mudança de codec selecionando level por `process.versions.bun` exige targets separados e oráculos corretos.

Plugins: após baseline de workspace válida, começar pelas rotas offline `--help`/`--version` e operações puras, depois protocolo MCP com stdin/stdout fake, validação de argumentos/erros e uma operação real em store temporário. SDK, schemas, export maps, build-info e assets de tokenizer precisam de tratamento explícito. `createRequire`, addons/N-API e JS carregado dinamicamente podem exigir integração nativa desenhada, não casts nem engine escondida.

Daemon: progredir de statusline/leases para IPC, sockets, timers/sinais, supervisão de child process, drain/backpressure e shutdown. Testar em sandbox descartável com fake clock/processos controlados e diretórios próprios, nunca usando o daemon operacional. Só depois qualificar caminhos de worker admission/recovery e execução longa. Um CLI que imprime versão não prova lifecycle, concorrência ou controle de recursos.

### P1-C — Node APIs priorizadas pelo workload, não pelo contador

O backlog atual tem 3.368 linhas de tasks e 6.663 itens por tier. Na parte static há 2.572 `verify-gap`, 590 `audit-partial`, 49 `replace-refusal`, 81 `implement` e três `classify`. Esses números vêm do JSON gerado, não são percentual de cobertura nem tickets independentes. Static inclui planejamento compartilhado e não constitui uma prova Rust por overload.

Para plugins/daemon, priorizar famílias: fs/fs-promises e paths; Buffer/TypedArray/codecs; processo/env/stdin/stdout; child_process/IPC e backpressure; events/timers/promises; net/Unix sockets/HTTP e streaming. Em cada uma, separar overloads já implementados mas mal mapeados de ausência real, e escrever testes dos erros e ciclo de vida. Crypto, TLS, compressão e integrações de banco devem seguir necessidades concretas do consumidor; não escolher todas as classes crypto só por estabilidade alta na heurística.

Aceite: seguir verification basis, confirmar registry gaps, usar Node 24.15.0 como oráculo, atualizar fontes implementation-owned, regenerar os artefatos e revisar o diff. Não modificar generated JSON manualmente. Zero ampliação de claims sem teste mapeado. O suporte dynamic-island não fecha uma lacuna static-native e não é a resposta para o objetivo TS→Rust sem engine.

### P1-D — memória e lifecycle corretos em processos longos

`forbid(unsafe_code)` no runtime e no programa gerado é uma boa barreira, mas não prova ausência de leaks lógicos, retenção excessiva, ciclos, starvation ou paridade de exceções. Ownership do Rust não é o mesmo contrato de identidade/aliasing do TS. Dependências como ring, runtime de SO e SQLite opcional têm fronteiras que precisam de inventário próprio.

Entregas: stress determinístico com observáveis de heap; criação/descarte de closures, registros, listeners, buffers/views, generators, filas e child writers; cancelamento e shutdown; verificações de cleanup após falha; RAM antes/depois de muitos ciclos e plateau; limites e critérios para crescimento permitido. Medir contadores e RSS separadamente. Auditoria de heap silenciosa em onze execuções curtas não qualifica um daemon que fica dias ligado.

### P2-A — performance com prova de efeitos e benchmark reproduzível

O último checkpoint histórico do redwall em 2026-09-09 relata mediana Rust 2.657,00 ms versus Bun compilado 1.046,69 ms, razão 2,54×, após melhorias de empréstimos e conversão u8. Isso substitui o relato histórico anterior de 6,61×; nenhum dos dois é medida atual desta investigação. Os consumidores/revisões/toolchains mudaram, portanto não usar essa razão como regressão comprovada atual.

Entregas: benchmark do renderer corrente com inputs idênticos, hash de fontes/assets/artefatos, warmup, amostras alternadas, mediana/variação, timeout e máquinas identificadas; medir tempo de runtime, pico RSS, tamanho e tempo de compilação separadamente. Perfis por fase: inflate, filtragem, encode, TTF/typeset/paint, cópias e alocações. Otimizar apenas após identificar hotpath; manter differential gate e teste de aliasing/efeitos para cada clone removido, empréstimo ou índice especializado.

Depois: boxing de dyn/union, representação de strings/arrays, chamadas/closures, dispatch e monomorfização. Metas de performance devem ser escolhidas por workload e custo de manutenção, não “Rust deveria ser mais rápido” como critério sem medição. Não regredir semântica para obter um gráfico melhor.

### P2-B — escala do frontend e custo de compilação

O frontend contém hotspots extensos: `program.ts` 3.540 linhas, `lowerer.ts` 6.799 e `type-mapper.ts` 3.849 na leitura atual. Esses números indicam complexidade de manutenção, não provam causa de lentidão ou exigem um rewrite imediato. O contrato anterior já pediu medição do checker TS7/IPC e workloads grandes.

Entregas: medir parse/checker/IPC/type mapping/lowering/validação/emissão/Cargo/rustc separadamente, com censos de queries, cache hit/miss e memória total da árvore de processos; benchmarks cold/warm e cache desabilitado; budget reprodutível para Redcode e consumidores. Introduzir índices/caches ou deepening de módulos apenas onde o perfil ou uma classe recorrente de erro demonstrar valor.

O cache antecipado de executáveis em `index.ts` exclui o backend Rust; portanto cache de frontend/runtime e cache completo do binário são problemas distintos. Medir o custo antes de adicionar cache Rust. O namespace atual do runtime separa raiz canonical, features, modo library e identidade de sanitizer, mas o caminho plain não inclui explicitamente host/rustc/flags na identidade mostrada. Cargo pode reconstruir por fingerprint; há uma hipótese de concorrência/ABI a auditar, não um wrong-code confirmado. Testar worktrees, toolchains, flags e features simultâneos, cold/warm e invalidation após mudança de fonte.

### P2-C — biblioteca/FFI, plataformas e distribuição

Uma aplicação standalone pode usar dependências nativas sem conter engine, mas isso não torna seu contrato uma conversão automática de qualquer biblioteca TS. Separar addon/N-API, banco/SQLite, geração de declarations, assets externos e ABI de biblioteca. Documentar ownership de strings/buffers/erros/callbacks no limite e testar repetição/reentrância/cleanup.

O driver atual recusa `SCRIPTC_TARGET` não-native: cross-compilation Rust não está implementada nessa rota. Avaliar Linux/macOS/Windows/WASI por necessidade real, sem declarar compatibilidade de host não executado. Pacotes, cache, path/env, sockets, sinais e subprocessos merecem testes por plataforma; contrato de Node target é independente de OS host.

Entregas: standalone executado sem Node/Bun no filesystem disponível; assets empacotados ou declarados; --help/--version offline; árvore de dependências/FFI auditável; artefato com proveniência; compatibilidade de toolchain/declarations; diagnóstico útil de plataforma indisponível. Não contar npm shims que despacham `process.execPath` para bundles JS como aplicações nativas.

### P2-D — diagnósticos e documentação verdadeiros

Classificar diagnóstico em erro TS de origem, dependência ausente, forma static recusada, erro do backend, toolchain/ambiente, panic do checker, timeout e incompatibilidade de execução. Agrupar cascatas por primeira causa sem perder localização e rastreio; SC1010 genérico de packages ausentes não deve virar automaticamente feature ticket.

Entregas: diagnóstico com fase, entrada/import chain, forma suportada e alternativa segura; snapshot de refusals estreitas; manifesto regenerado das fontes; docs que diferenciem emitter acceptance, build, execução e gate. Reconciliar planos antigos, README Test262 e estado já integrado de Wave6. Não repetir “Clippy tem 23 erros” do plano antigo quando o run fresco está verde.

## 6. Sequência prática e critérios de conclusão

1. Fixar a baseline de validação estável e promover os witnesses desta investigação para testes permanentes. Primeira correção: ordem de propriedades, pois há comportamento divergente de programa aceito. Aceite: witness e parser diferencial verdes, sem ordenar a saída no teste.
2. Separar grafo de tipos e execução. Aceite: witness ambient type-only compila sem runtime dependency, import de valor ainda é fiscalizado e renderer original deixa de ser recusado por Tuiuiu espúrio; checker continua íntegro.
3. Introduzir lane Test262 Rust estável e resolver/refinar as falhas efetivamente encontradas. Aceite: relatórios por backend sem fallback, crashes tratados como bugs, perfil e exclusões explícitos, gates integralmente executáveis no ambiente apropriado.
4. Implementar família Array.from(bytes) e completar regressões de identidade, ordem, presença e efeitos nas conversões mais usadas. Aceite: corpus Node/Rust byte a byte, docs/manifestos com escopo estreito.
5. Qualificar redwall completo no snapshot atual; decidir contrato de compressão e medir performance corrente. Aceite: contratos do renderer, assets e rastreabilidade; nada de reutilizar benchmark histórico como número atual.
6. Materializar baseline descartável dos workspaces e avançar um plugin real, uma operação de cada vez. Aceite: fontes/dependencies originais, protocolo com fixture isolada e artefato standalone, não launcher.
7. Avançar runtime assíncrono para daemon: IPC, subprocesso, backpressure, timers/sinais e shutdown; depois lifecycle longo e recovery. Aceite: stress determinístico, ausência de retenção indevida e processos operacionais não afetados.
8. Só então priorizar expansão ampla de APIs, otimizações adicionais, cache completo Rust e novas plataformas segundo os bloqueios reais medidos. Cada slice mantém gates e prova de semântica.

Não atribuo datas ou “percentual concluído”: os aplicativos completos ainda não têm baseline válida nesta instalação, e uma única mudança de representação pode fechar ou abrir muitas linhas. O critério de pronto por slice é concreto: inputs fixos, Node pinado, Rust estável, zero engine/fallback, stdout/stderr/status iguais, artefatos sob contrato explícito, cleanup, testes negativos, metadata e gates exigidos.

## 7. Configuração e detalhes operacionais usados

Os probes usaram `RUSTUP_TOOLCHAIN=1.98.1`, `CARGO_NET_OFFLINE=true`, `CARGO_BUILD_JOBS=1`, `SCRIPTC_NATIVE_WORKERS=1`, `SCRIPTC_NATIVE_HOST_WORKERS=1`, TMPDIR no scratch do workspace, cache e native-lock também dentro do workspace. Variáveis de um loop shell precisam estar exportadas: primeiras tentativas com variáveis shell não exportadas buscaram `/run/user/1000` ou `~/.cache` e falharam EROFS. Essas tentativas são erros do harness, não lacunas do compilador; os builds finais foram repetidos com exports corretos.

O harness em [contracts.sh](../tmp/ts-rust-stable-audit-20260930/contracts.sh) contém os comandos efetivamente executados e as redireções dos contratos; [probe.mjs](../tmp/ts-rust-stable-audit-20260930/probe.mjs) registra opções, versão Node, hash da entrada, diagnósticos e resultado. Source emission não é build native, `analyze` não é execução e aceite do CLI build não é standalone comprovado. Os sete binários foram executados; isolamento sem Node/Bun no filesystem não foi testado nesta rodada.

## 8. Riscos, perguntas abertas e postura de contexto

- Representação de ordem: metadata por instância, layout especializado por ordem ou transição para representação dinâmica? Decidir após inspecionar IR e medir custo; não escolher um rewrite geral sem necessidade.
- Compressão: o produto quer fidelidade byte a byte ao Node pinado, ao Bun target ou somente conteúdo decodificado? A política atual favorece diferencial exato; qualquer exceção precisa ser explícita e estreita.
- Workspaces: quais configurações/export maps/build defines são parte da promessa compiler, e quais são responsabilidade do build original do consumidor? Produzir baseline instalada para responder com evidência.
- Toolchain: manter pin 1.98.0 com ambiente capaz de instalá-lo ou atualizá-lo deliberadamente para outro estável? Não confundir falta local do pin com necessidade de nightly.
- Compatibilidade: quais rotas de daemon/plugins são o próximo objetivo útil de produto? A proposta é kernel → protocolo isolado → operação real temporária → lifecycle, não servidor operacional direto.
- Integrações: js-tiktoken/createRequire, banco e SDKs precisam de quais assets/adapters/ABIs? Não assumir engine ou implementar integrações externas sem contrato.
- O contexto atual vem de AGENTS.md, planos e pesquisas locais. Não foi encontrada coleção ADR/context glossary própria nem Memory/Wiki configurados no scriptc; decisões importantes precisam de documentação local rastreável, sem inventar memória externa ou registrar conteúdo nos stores dos consumidores.

## 9. Notas por fonte e limites de interpretação

A documentação de módulos TypeScript confirma que importações explicitamente de tipo são apagadas na emissão; isso orienta a separação de grafo, mas não autoriza suprimir diagnósticos legítimos de tipagem de arquivos usados pelo checker. A documentação de compatibilidade descreve o sistema estrutural e suas concessões deliberadas; por isso anotações de tipo não devem alterar a ordem, identidade ou coerções observáveis em runtime.

O livro de Rust explica ownership/borrowing do destino, mas não estabelece que a tradução respeita a origem. A documentação Node 24.15.0 ancora o oráculo e a API zlib; igualdade de raster foi medida localmente, não deduzida da documentação. A especificação oficial de Array.from ajuda a desenhar callbacks e iteração; a recusa de TypedArray foi comprovada pelos probes em ambos os targets.

Inventários e manifestos locais orientam investigação, não provam suporte comportamental sem testes. O benchmark redwall histórico tem seu próprio conjunto de fontes/artefatos e não é baseline de hoje. Logs frescos confirmam Clippy estável, builds e saídas dos kernels; não confirmam gates full, pin exato, aplicação integral, conformidade ECMAScript inteira ou ausência de bugs restantes.

## Recomendação final

O primeiro ciclo de implementação deve ser pequeno e decisivo: corrigir ordem observável de propriedades, fechar o diferencial do parser red-dev, separar o grafo runtime de type-only imports e habilitar Test262 no Rust estável. Isso melhora confiança e desbloqueia dogfood verdadeiro. A expansão de APIs e a busca de performance passam a ser guiadas por consumidores originais e perfis medidos, com nightly fora do caminho principal.
