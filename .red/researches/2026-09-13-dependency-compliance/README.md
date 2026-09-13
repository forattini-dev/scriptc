# Dependências e tipagem: o que impede TS → Rust nativo

Levantamento de 2026-09-13 para os 18 entrypoints originais de red-skills, redcode e red-dev. **Há lacunas reais de tipagem, mas elas não explicam sozinhas as builds bloqueadas.** Encontramos tipos já disponíveis que o scriptc não inclui, dependências tipadas que a configuração não admite, tipos expressivos ainda sem representação nativa e APIs de Node/Bun/FFI/WASM ainda sem implementação.

O requisito pedido pelo mantenedor está registrado em [Descoberta proativa de tipagens](type-discovery-requirement.md). Antes de responsabilizar o consumidor, o compilador deve procurar e explicar a proveniência dos tipos aplicáveis ao import exato. A primeira correção indicada pelo levantamento é incluir as declarações ambientes que o consumidor já mantém no tsconfig.

## Escopo e inventário completo

| Medida | Resultado | Interpretação |
|---|---:|---|
| Entrypoints originais | 18 | 13 red-skills, 3 redcode, 2 red-dev |
| Arquivos analisados para imports | 2.298 | Grafo estático do workspace complementado pelas fontes runtime capturadas nas tentativas anteriores |
| Nomes externos encontrados nos imports | 122 | 135 instalações/versões/caminhos; inclui imports de tipos e código condicional |
| Nomes com sintaxe de import não exclusivamente de tipos | 118 | Não é prova de que todos executam; TS também pode eliminar imports usados somente como tipos |
| Fechamento declarado de dependências | 874 nomes / 1.147 instalações | Inclui runtime, optional e peer das dependências alcançadas; é uma aproximação conservadora, não 874 dependências comprovadamente executadas |
| Imports JS sem declaração resolvida | 9 subcaminhos em 8 pacotes | Dois pontos diretamente usados pelo consumidor e seis pacotes transitivos; tabela abaixo |
| Pacotes observados com tipos em `@types` instalados | 11 | Tipos encontrados, mas recusados pela heurística de admissão automática atual |
| Imports/carregamentos não literais | 28 ocorrências no total | Listados em arquivo; não foram adivinhados ou executados |

Os CSVs permitem filtrar cada pacote por versão, programa, subcaminho, implementação publicada, declarações encontradas e caminho de instalação:

- [Todos os pacotes do fechamento declarado](all-dependencies.csv).
- [Pacotes diretamente observados no grafo analisado](observed-dependencies.csv).
- [Imports exatos e resolução de tipos/runtime](imports.csv).
- [JS observado sem declaração resolvida](observed-js-without-declarations.csv).
- [Tipos externos disponíveis](available-external-types.csv).
- [Superfícies transitivas que precisam de investigação](transitive-unresolved-type-surfaces.csv).
- [Dependências declaradas não resolvidas](unresolved-declared-dependencies.csv).

No fechamento conservador, 73 instalações sem declarações têm candidatos de JSDoc no entrypoint; 237 não tiveram declarações encontradas; 13 contêm arquivos TS/declarativos, mas não tiveram uma superfície de raiz resolvida nos contextos sondados. Esses números não significam 323 pacotes incompatíveis: incluem entradas condicionais, pacotes nativos, subcaminhos, versões repetidas e código não comprovadamente usado. As 169 arestas de dependência não resolvidas também incluem peers/opcionais/plataformas; não são 169 falhas de instalação comprovadas. O CSV preserva o tipo da aresta para investigar corretamente.

## Lacunas de tipos realmente encontradas nos imports JavaScript

| Pacote instalado / subcaminho | Uso encontrado | Tipagem e ação indicada |
|---|---|---|
| `@npmcli/config@10.8.1` e `/lib/definitions/index.js` | `redcode/packages/core/src/npm-config.ts:5,7` | O consumidor documenta a falta de tipos e suprime os erros. Definir um contrato fiel às APIs usadas ou avaliar declarações compatíveis. A raiz e o subcaminho precisam ser analisados separadamente. |
| `@parcel/watcher@2.5.1/wrapper` | `redcode/packages/core/src/filesystem/watcher.ts:4` | A raiz do pacote tem tipos; o wrapper privado não. O `as typeof import('@parcel/watcher')` tipa a fachada retornada, sem verificar o corpo/entrada. Preferir API pública quando equivalente ou declarar/verificar o contrato do wrapper. A ligação `.node` permanece um problema independente. |
| `@npmcli/map-workspaces@5.0.3` | Runtime de `@npmcli/config` | Inferência observada: `Promise<Map<any, any>>`; faltam contratos precisos de opções e mapeamento. |
| `ini@6.0.0` | Runtime de `@npmcli/config` | Encoder infere `string`; parser devolve `any`. Precisamos de contrato para dados estruturados e validação da fronteira. |
| `nopt@9.0.0` | Runtime de `@npmcli/config` | Opções e resultados de chaves dinâmicas ficam parcialmente `any`. Avaliar declarações compatíveis e modelar o resultado real. |
| `proc-log@6.1.0` | Runtime de `@npmcli/config` | Eventos, argumentos variádicos e callbacks usam `any`. Contratos de eventos e semântica de process/Promise continuam necessários. |
| `is-glob@4.0.3` | Runtime do wrapper de watcher | Inferência já identifica retorno `boolean`, mas parâmetros são `any`. É candidato a inferência melhor no compilador; não exige necessariamente reescrita em TS. |
| `is-extglob@2.1.1` | Runtime de `is-glob` | Mesmo caso: predicado com guardas de string e retorno booleano inferível. |

Os seis transitivos não foram selecionados na lista estática da última build completa e não são nomeados diretamente nos 3.090 diagnósticos por pacote/localização. São uma frente adicional descoberta; não se pode atribuir a eles aquela contagem de erros. [Sondagem dos seis transitivos](transitive-typing-probe.md).

Consultamos o npm sem instalar nada: existem candidatos `@types` para todos esses nomes e também para `js-yaml`. [Versões, URLs, datas e limites da consulta](registry-types-candidates.md). A compatibilidade com as versões instaladas não foi demonstrada. Vários candidatos tipam versões principais mais antigas. A inspeção dos tarballs confirmou que `@types/npmcli__config@6.0.4` também contém `lib/definitions/index.d.ts`, mas `@types/parcel__watcher@2.0.5` contém somente a declaração da raiz e não cobre `wrapper`/`createWrapper`. Instalar os tipos da raiz não resolve esse subcaminho privado. Tarballs foram inspecionados em memória, sem extração/execução, e conferidos contra a integridade publicada; os resultados estão em `registry-subpath-probe.json`.

## Tipos disponíveis que não devem virar trabalho desnecessário no consumidor

| Caso | Evidência | Responsabilidade |
|---|---|---|
| `js-yaml@4.3.0` no red-skills | Já existe `apps/dev/src/types/js-yaml.d.ts`, incluído pelo tsconfig, com `load(input: string): unknown`. O scriptc o deixa fora. O mesmo importador no TS perde o erro quando a declaração existente é incluída. | **scriptc:** adoção das declarações ambientes do projeto. Não pedir outra declaração ou um shim `any`. |
| Assets Bun do red-dev | 20 dos 21 imports diagnosticados como `any` já possuem declarações locais de string em `src/shims.d.ts`. A sondagem com os shims recupera os tipos. | **scriptc:** incluir os shims e implementar o carregamento de texto/arquivo. Tipar não equivale a embutir o recurso. |
| `yargs`, `cross-spawn`, `mime-types` e outros oito | `@types` resolve nos imports reais. A heurística AUTO recusa explicitamente tipos externos. | **scriptc:** melhorar seleção e ligação verificável do contrato ao corpo JS. Instalar tipos novamente não resolve a política atual. |
| `cli-args-parser@1.0.6` e `tuiuiu.js@1.0.75` | Runtime publicado em JS + declarações próprias; raiz e `/hooks` resolvem; as funções consultadas não são `any`. Nenhum npm transitivo foi encontrado no grafo de seus entrypoints usados. | **scriptc:** inferência/admissão e APIs nativas. Não há justificativa de tipagem para trocar essas bibliotecas. |
| `effect`, `drizzle-orm`, `zod`, SDKs e fontes TS do workspace | Tipos concretos/genericamente expressivos existem. Há diagnósticos de genéricos, concorrência Effect, callbacks, estruturas e APIs sem lowering. | **scriptc:** semântica e representação nativa; mais anotações não implementam operações ausentes. |
| `rsp`: `let child` | TS infere corretamente `ChildProcessByStdio<null, Readable, Readable>` nos quatro usos; o scriptc perde essa informação. | **scriptc:** inferência de fluxo/representação. Anotação explícita é uma simplificação possível, não uma falha dos tipos de Node. |

Os 11 pacotes com `@types` encontrados são `@npmcli/arborist`, `@npmcli/package-json`, `cross-spawn`, `micromatch`, `mime-types`, `npm-package-arg`, `semver`, `turndown`, `which`, `ws` e `yargs`. As versões efetivas das declarações aparecem nos caminhos do CSV; compatibilidade de API deve ser verificada, especialmente quando a versão principal difere da implementação.

## Pré-requisitos e contratos que pertencem aos consumidores

1. **red-dev / Bun:** o tsconfig pede `types: ["bun-types"]`, mas o pacote diretamente exposto nesta instalação é `@types/bun`. A sondagem com `types: ["bun"]` resolve o erro TS2688. Alinhar declaração de dependência, instalação e configuração. O scriptc já faz resolução separada de `bun`; isso não explica toda a recusa nativa.
2. **red-dev / TOML:** o import de `starship.toml` pede conteúdo textual, enquanto o tipo genérico Bun para TOML é `any`. Especificar corretamente essa fronteira de texto; o compilador também precisa respeitar o atributo do loader.
3. **Herdr:** faltam os links de instalação do pacote. Os dois imports `@reddb-io/build-info` e `@reddb-io/toon` são declarados e têm tipos em outros contextos, mas a resolução ESM do entrypoint original falha neste checkout. Restaurar o ambiente de dependências, sem substituir a entrada por bundle baixado.
4. **Redwall:** a entrada auditada é um template com três imports relativos que só existem depois do staging. Fornecer a entrada preparada e os assets/exports gerados. O script atual de preparação também reescreve código e aciona `--dynamic`, portanto não comprova equivalência de fontes nem build Rust nativa por si só.
5. **Contratos apagados pelo consumidor:** `MemoryOperationDefinition<any, any>[]` no registry de memória e o retorno `data` aberto de gray-matter merecem contratos e validação de domínio. Não foi demonstrado que apertar esses tipos sozinho destrava a build; suporte a Zod/estruturas continua independente.

Dependências estrangeiras também exigem decisões separadas: `@ff-labs/fff-bun` publica TS, mas usa `bun:ffi`/`dlopen`; Photon possui declarações, mas precisa de WebAssembly; watcher e node-pty dependem de bindings nativos. Tipagem não substitui essas implementações nem transforma automaticamente uma biblioteca externa em Rust.

## Relação com as builds bloqueadas

Os diagnósticos consultados são históricos para 17 entradas (`f1087c89`) e atuais no último experimento da CLI completa (`5e0830c2`). Não refizemos as 18 builds nesta auditoria. Os arquivos consumidores revalidados permaneceram inalterados; timeouts de lildax continuam inconclusivos.

| Evidência | O que permite concluir |
|---|---|
| Redcode: 643 SC2013, 40 proprietários de símbolos de pacote | 33 têm declarações próprias ou TS, seis usam `@types`, um é `@npmcli/config`. Outros 225 SC2013 da contagem de 643 são propagação de imports relativos/aliases. SC2013 não significa “sem tipos”. |
| Red-skills: 681 SC2013 envolvendo 12 pacotes | Todos os 12 têm tipos próprios ou TS nos importadores sondados; a tentativa estava com seleção npm estática OFF. |
| Red-dev: 19 SC2013 e 177 SC2020 | Há tipos disponíveis; a configuração/admissão e APIs sem lowering são fronteiras distintas. |
| `SC0004`, `SC2004` e tipos com `unknown` | Há falhas do checker e cascatas. `unknown` é um tipo seguro e intencional; não contar essas ocorrências como dependências sem tipagem. |

**A prioridade indicada pela evidência é corrigir a descoberta/inclusão de tipos no scriptc, melhorar a admissão de JS tipado e avançar nas operações nativas.** Em paralelo, os consumidores devem fornecer entradas/assets coerentes, dependências instaladas e contratos reais nas poucas fronteiras não tipadas. Não há base para reescrever todas as dependências JS em TS nem para prometer que instalar `@types` resolve o Redcode.

## Reprodução, proveniência e limites

`inventory.mts` usa o parser/resolvedor TypeScript 5.9.3, o resolvedor do scriptc e a heurística de seleção npm do checkout. `assess-surfaces.mts` consulta superfícies de raiz em contextos das dependências declaradas. `consolidate.py` monta as tabelas sem alterar fontes. As sondagens específicas de cada repo e a consulta pública ao npm estão preservadas junto ao relatório.

A linguagem de autoria não foi inferida a partir de JS publicado. Declarações encontradas não são prova de que todos os membros estejam precisamente tipados, nem de que o corpo implemente o contrato. Imports calculados, branches condicionais, carregadores de assets e dependências declaradas mas não alcançadas limitam qualquer afirmação de cobertura runtime. Não executamos dependências baixadas, não instalamos pacotes, não alteramos consumidores, não fizemos novas builds completas ou benchmarks.

O [resumo estruturado](summary.json), [diagnósticos por programa](diagnostics-summary.json) e [índice de evidências](evidence-index.json) preservam contagens, commits, hashes e caminhos. Os logs completos e capturas extensas permanecem em `/tmp/scriptc-dependency-compliance-20260913`; os resultados compactos e scripts ficam neste checkpoint.
