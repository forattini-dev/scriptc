# Redcode: dependências, tipagem e causas da recusa nativa

Data: 2026-09-13. Auditoria somente de leitura. CLI original: `packages/redcode/src/index.ts`.

**A falta de tipagem existe em algumas fronteiras, mas não explica a recusa da CLI inteira.** A tentativa original produziu 3.090 ocorrências; muitas dizem explicitamente que o compilador não implementa determinada semântica de TypeScript/JavaScript, API de Effect ou API de runtime. Mesmo que as declarações ausentes fossem fornecidas, esses bloqueios continuariam.

Evidência: `/tmp/scriptc-redcode-native-proxy-20260913a/build.json`; compilador fonte `5e0830c24a73a2122b6ecec430c4d31b810de215`; consumidor `b8fa0e8e31cd6dac384347f4852fc7b3c8519a86`. O JSON deste levantamento preserva versões, caminhos completos, posições, trechos, códigos e hash da evidência. O inventário de imports usado na extensão transitiva é `imports.json`, produzido pela auditoria paralela; seu hash também está registrado.

## O que é uma dependência tipada

- Um pacote distribuído em JS com `.d.ts`, `.d.mts` ou `.d.cts` **tem tipagem**. Não é correto exigir reescrita em TS só pela extensão do arquivo distribuído.
- `@types/*` instalado pode fornecer tipagem válida. São declarações, não bibliotecas executáveis separadas.
- Uma declaração local concreta pode tipar uma API usada: Redcode já tem essas declarações para `ssh2` e `gifenc`.
- `unknown` é um tipo explícito e seguro. Não equivale a ausência de tipagem.
- Ter tipos não garante compilação nativa: é preciso compilar o corpo real, dependências transitivas e APIs de sistema. A linguagem de autoria não foi inferida a partir de JS distribuído.

O scriptc possui uma distinção deliberada em `packages/compiler/src/frontend/npm-static.ts:1-65`: em `--npm-static`, esconde declarações executáveis e infere os corpos reais. A regra automática em `npmStaticIneligibleReason` (linha462) ainda recusa tipagem fornecida por terceiros em `@types`, ausência de declaração própria, entrada sem resolução, minificação e runtime webpack. **Recusa por essa política não significa que o consumidor não tem tipos.** A última tentativa da CLI usou34 pacotes explicitamente selecionados, não admissão automática de todas as dependências.

## Fronteiras realmente sem declaração resolvida

O inventário observado identifica9 arestas de imports JS em8 pacotes do grafo da CLI sem declaração resolvida. Essa é a cobertura do grafo observado, não uma promessa de fechamento transitivo integral de todos os pacotes npm.

| Pacote / versão | Import usado / origem | Evidência e responsabilidade |
|---|---|---|
| `@npmcli/config`10.8.1 | raiz e `lib/definitions/index.js`; `core/src/npm-config.ts:5,7` | Dois `@ts-expect-error` documentam ausência de tipos. `config.flat` é convertido em `Record<string, unknown>`; isso não tipa construtor, `load()` e definições. Contrato mínimo no consumidor/pacote; execução dos corpos e dependências no compilador. |
| `@parcel/watcher`2.5.1 | **somente subpath** `@parcel/watcher/wrapper`; `core/src/filesystem/watcher.ts:4` | `@ts-ignore` na linha3; `createWrapper(binding) as typeof import('@parcel/watcher')` na linha32. A raiz possui `index.d.ts`; o wrapper privado não. Precisa contrato específico de entrada e saída, além de suporte ao addon nativo. |
| `@npmcli/map-workspaces`5.0.3 | `@npmcli/config/lib/index.js:738` | JS sem declaração resolvida; transitivo do config. |
| `ini`6.0.0 | `@npmcli/config/lib/index.js:3` | JS sem declaração resolvida; transitivo do config. |
| `nopt`9.0.0 | `@npmcli/config/lib/index.js:4` | JS sem declaração resolvida; transitivo do config. |
| `proc-log`6.1.0 | `@npmcli/config/lib/index.js:5` | JS sem declaração resolvida; transitivo do config. |
| `is-glob`4.0.3 | `@parcel/watcher/wrapper.js:3` | JS sem declaração resolvida; transitivo do wrapper. |
| `is-extglob`2.1.1 | `is-glob/index.js:8` | JS sem declaração resolvida; transitivo de `is-glob`. |

Não foram instaladas declarações, usados casts fictícios nem alterados consumidores. Ausência de declaração não prova impossibilidade de inferência do corpo; o scriptc precisa continuar seguro quando essa inferência não comprova uma fronteira.

## Tipos presentes, mas fora da admissão atual

Seis identidades de `@types` aparecem nos erros. As versões atuais dos executáveis correspondentes são:

| Runtime | Declarações instaladas | Diagnósticos SC2013 |
|---|---|---:|
| `yargs`18.0.0 | `@types/yargs`17.0.33, incluindo `helpers` |14|
| `cross-spawn`7.0.6 | `@types/cross-spawn`6.0.6 |2|
| `mime-types`3.0.2 | `@types/mime-types`3.0.1 |2|
| `npm-package-arg`13.0.2 | `@types/npm-package-arg`6.1.4 |2|
| `turndown`7.2.0 | `@types/turndown`5.0.5 |4|
| `which`6.0.1 | `@types/which`3.0.4 |1|

Os majors diferentes merecem uma revisão de contrato das APIs realmente utilizadas; não demonstram por si só erro de tipagem ou incompatibilidade. Todos têm declarações encontradas. Trocar seus tipos por `any` não resolveria a compilação e perderia garantias.

## Contraexemplos: bibliotecas tipadas também bloqueiam

| Dependência | Tipagem verificada | Bloqueio observado |
|---|---|---|
| `drizzle-orm`1.0.0-rc.2 | `index.d.ts`, `sqlite-core/index.d.ts`, exports com condições de tipos |165 SC2013; `core/src/account/sql.ts:1` importa `drizzle-orm/sqlite-core`. Fora da lista npm estática dessa tentativa. |
| `zod`4.1.8 | `index.d.cts`, `index.d.ts` e fontes TS distribuídas |51 SC2013. Tipagem existe; isso não implementa suas estruturas dinâmicas no Rust. |
| `@ai-sdk/provider-utils`4.0.23 | `dist/index.d.ts` |24 SC2013. Pacote não selecionado na tentativa. |
| `effect`4.0.0-beta.83 | `dist/Effect.d.ts` e `src/Effect.ts` |Suporte nativo parcial por kernels: o compilador recusa concorrência diferente de1, determinadas formas de `Effect.tryPromise`, `Context.Reference`, `Brand.nominal`, `Schema` e outros. |
| `@effect/platform-node`4.0.0-beta.83 | `dist/index.d.ts`, declarações de subpaths e fontes TS |6 SC2013. Não é falta de tipos; implementar APIs de plataforma é outra tarefa. |
| `@reddb-io/redcode-schema`1.20.1 | exports apontam para `src/*.ts` |59 SC2013 nos subpaths; muitos são propagação de dependências/kernels bloqueados. O workspace já é TS. |
| `@reddb-io/redcode-tui`1.21.2 | fontes `.ts`/`.tsx` nas exportações |4 SC2013; ser TS não elimina necessidade de JSX/renderização e bibliotecas suportadas. |

Na própria `filesystem/watcher.ts`, além do wrapper sem declaração, há recusa de `Effect.context`, `Effect.runForkWith`, `Effect.forkScoped` e `Promise.allSettled`. Dar tipos a `createWrapper` não implementa essas operações.

## Dependências nativas e assets: tipagem não é a fronteira principal

| Pacote / artefato | Evidência instalada | Implicação |
|---|---|---|
| `@ff-labs/fff-bun`0.9.4 | Distribui runtime TS; `src/ffi.ts:11` importa `bun:ffi`; linha302 chama `dlopen`. | Contraexemplo forte a “use TS e tudo compila”: precisa ABI/FFI, bibliotecas e integração do target. |
| `@parcel/watcher`2.5.1 | `index.js` carrega pacote por plataforma ou `watcher.node`; consumidor também faz `require` calculado. | Precisa caminho nativo equivalente ou ponte verificada, além do contrato do wrapper. |
| `@silvia-odwyer/photon-node`0.3.4 | `photon_rs.d.ts`; `photon_rs.js:4514-4518` lê `.wasm`, cria `WebAssembly.Module/Instance`. | Tipado, mas requer implementação/integração WASM ou alternativa nativa com semântica equivalente. |
| MP3 do `redcode-ui`, `photon_rs_bg.wasm`, `opencode-web-ui.gen.ts` | Imports observados pelo scanner; resolução de módulo JS/TS não encontrou entrada comum. | Assets e módulo gerado pelo build não devem ser contados como bibliotecas JS sem tipos. Precisam pipeline de assets/geração e inclusão. |

## Relação com os3.090 diagnósticos

- `SC2013`:643 ocorrências.225 são propagação em imports relativos/aliases;418 citam60 labels, reduzidos a40 nomes de pacotes proprietários dos símbolos.
- Desses40,33 possuem declarações próprias ou TS distribuído;6 usam `@types`;1 não oferece declaração (`@npmcli/config`). O pacote `@parcel/watcher`, embora tenha declaração na raiz, possui também o subpath privado sem tipos listado acima. A classificação por pacote isolada esconderia essa diferença.
- `SC1090`:1.303 ocorrências de semântica ainda não suportada, incluindo205 `tx.run` e diversas instanciações/cascatas. O conjunto de mensagens que mencionam kernel Effect ou `Schema.Struct` não literal soma158; essa busca textual não é uma partição causal completa.
- `SC2009`:449 ocorrências de uma forma externa conhecida com componente não compilável; isso inclui tipos ricos e assinaturas concretas, não apenas `any`.
- `SC2004`:288 usos que herdam erro de uma declaração. Não são288 problemas novos.
- `SC2020`:119 recusas de APIs/construções de biblioteca padrão. `SC0004`:2 falhas do checker TypeScript-go.

Não é possível dizer que “tipar essas8 dependências elimina X%” sem testes diferenciais controlados. A evidência já basta para rejeitar a conclusão de que a CLI falha somente porque suas dependências não são TS ou não têm tipos.

## Próximas ações recomendadas

1. No consumidor/pacote: especificar contratos reais dos dois imports de `@npmcli/config` e do wrapper privado do watcher; validar APIs/versões de `@types` utilizadas; tornar assets e entradas geradas explícitos no build.
2. No scriptc: separar no diagnóstico ausência de contrato, exclusão pela política npm, erro herdado, API de runtime sem implementação e limitação de lowering. Atualmente SC2013 agrega situações diferentes.
3. No scriptc: ampliar a admissão e inferência de JS legível mantendo checagens, e resolver famílias grandes de semântica tipada (Effect/Schema, genéricos e chamadas, memória/identidade, promessas, módulos).
4. Para addons, FFI, WASM e módulos carregados por nome calculado: projetar suporte explícito por target. Acrescentar `.d.ts` não cria esse suporte.
5. Após cada mudança de contrato ou compilador: repetir exatamente o entrypoint original, mesmas opções e captura de fontes, e comparar causas removidas/novas. Não substituir a CLI por fixture.

Nenhuma build completa ou typecheck integral foi rodada nesta auditoria. O levantamento não afirma que todos os imports observados são executados em todo comando da CLI, nem que o grafo observado alcançou todas as dependências carregadas dinamicamente.
