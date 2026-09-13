# Requisito: descoberta proativa de tipagens

Solicitação do mantenedor em 2026-09-13: “temos que ser mais proativos em buscar as tipagens dentro das dependencias também”. Este é trabalho do compilador e passa a integrar os próximos passos da missão TS → Rust nativo. Implementação em andamento; os marcos abaixo distinguem entrega de trabalho pendente.

Antes de diagnosticar ausência de tipos ou recomendar mudanças no consumidor, o scriptc deve procurar e explicar as fontes de tipagem aplicáveis ao import exato: fontes TypeScript publicadas, `exports` condicionais com `types`, `types`/`typings`, `typesVersions`, declarações `.d.ts`/`.d.mts`/`.d.cts` adjacentes, pacotes `@types`, declarações ambientes locais incluídas pelo `tsconfig` e JSDoc. A busca deve respeitar o subcaminho, a versão instalada, as condições do runtime e os limites de exports do pacote; não deve inventar acesso a arquivos privados.

O diagnóstico deve distinguir tipos ausentes, tipos disponíveis mas não descobertos/incluídos, tipos encontrados mas ainda não suportados na representação nativa, dependência não selecionada para compilação estática e APIs/runtime externos ainda sem implementação. `unknown` com validação e tipos genéricos expressivos não são evidência automática de tipagem insuficiente.

O caso reproduzido de `js-yaml` é o primeiro contrato de aceitação: `red-skills/apps/dev/src/types/js-yaml.d.ts` já declara `load(input: string): unknown` e está incluído pelo tsconfig do consumidor. A carga atual do scriptc deixa esse arquivo fora do programa. O TypeScript resolve o erro do importador quando a declaração existente é incluída. O consumidor não deve precisar duplicar essa declaração nem adicioná-la manualmente a cada entrypoint.

Outros contratos necessários: um pacote JS com declarações próprias; um pacote com tipos em `@types`; export condicionado com tipos por subcaminho; tipos fornecidos por JSDoc; subcaminho genuinamente não tipado mesmo quando a raiz do pacote tem tipos; e versão incompatível das declarações com diagnóstico específico. Cada positivo deve comprovar resolução, uso efetivo dos tipos e comportamento do código nativo.

Encontrar uma declaração não autoriza confiar cegamente nela nem substituir a implementação por uma assinatura. A compilação nativa deve continuar verificando corpos, identidade de referências, efeitos e limites de runtime. A melhoria precisa conectar o contrato descoberto ao corpo executável de maneira verificável. O AUTO não deve confundir “tipos de terceiros” com “nenhuma tipagem disponível”; a ampliação da admissão precisa de validação de compatibilidade.

Próxima ordem de execução: corrigir adoção de declarações ambientes do tsconfig; tornar explícita a proveniência dos tipos no diagnóstico; revisar admissão de `@types` e a ponte entre declarações e implementação JS; cobrir subcaminhos/condições/JSDoc; repetir builds dos entrypoints originais e os gates completos antes de integrar.


## Checkpoint: declarações do projeto

Implementada a inclusão de declarações configuradas por `files`/`include`, `extends`, referências de projeto e configurações dos fontes de workspace efetivamente alcançados. `types` e `typeRoots` explícitos usam o próprio TS7 para resolver suas declarações. Arquivos executáveis não importados continuam fora da compilação; declarações adjacentes a JS preservam a inferência pelo corpo.

Tipos estruturais das declarações locais configuradas podem ser representados nativamente. A identidade é registrada por SourceFile do programa, sem permitir que uma carga contamine outra. Bibliotecas externas e vínculos de runtime continuam com suas próprias barreiras.

Evidência em 2026-09-13: sete testes de configuração passaram; a seleção diferencial Rust e testes relacionados teve 43 positivos, com um fixture sem package.json corrigido e revalidado na suíte de configuração. O corpus 3251 verifica registros declarados e ReferenceError de global sem implementação contra Node. Build do compiler e lint passaram (lint mantém avisos preexistentes). O importador original `red-skills/apps/dev/src/core/toon-version.ts` agora inclui seu `js-yaml.d.ts` existente e retorna zero diagnósticos de preflight, sem alterações no consumidor.

Gate completo plain + sanitized ainda pendente. Aquisição automática com cache, integridade, lock e modos offline/frozen ainda pendente neste checkpoint. Isso não prova compilação integral do Redcode.
