# Valores de função com rest tipado

O frontend já empacotava parâmetros rest em chamadas diretas, mas rejeitava a mesma função quando armazenada numa variável, passada como callback ou retornada por outra função. A captura estável do Redcode contém 16 diagnósticos que mencionam rest; são ocorrências, inclusive cascatas, não 16 causas independentes. Um dos padrões está em packages/llm/src/schema/options.ts: uma arrow que recebe readonly (Record<string, string> | undefined)[].

## Reprodução e causa

O corpus 3253 reproduziu SC2009 no tipo Join e SC1090 ao transformar a declaração com rest em valor. O corpus 3254 reduz o padrão de dicionários opcionais do Redcode sem importar bibliotecas. A investigação confirmou três partes necessárias: mapType recusava arrays rest habitados; os produtores de closures não carregavam uma convenção de rest tipado; as chamadas indiretas completavam somente posições fixas. O caso de callback armazenado em campo de record revelou uma cópia adicional dessa lógica e também recebeu regressão.

## Implementação

O IR admite rest: true com restAbi: array. O último parâmetro continua sendo um array tipado explícito, distinguível de uma função que recebe um único array e da convenção dinâmica que esconde um array de argumentos. A identidade do tipo inclui a convenção, a serialização a preserva e o validador rejeita slots inválidos. O dispatch Rust usa a quantidade de slots explícitos, sem acrescentar o argumento dinâmico oculto.

function-abi.ts centraliza a construção do tipo das closures e a conclusão de chamadas indiretas. Chamadas através de variáveis, campos de records/classes, campos estáticos, namespaces e exports reutilizam o empacotamento já empregado pelas chamadas diretas. Foram removidas cópias dessa lógica e reduzidos os limites registrados dos arquivos antigos; nenhum teto de tamanho foi aumentado.

O caminho permanece tipado e nativo. Adaptadores de uma função com rest tipado para chamadas dinâmicas ou engine continuam recusados: ainda precisam validar cada elemento do array de argumentos, em vez de interpretar o array como um único argumento. A mudança também não promete adaptação entre callbacks de assinatura fixa e variádica, spreads que ocupam posições fixas, nem qualquer API Node/Bun adicional.

## Validação

Os novos diferenciais exigem Rust, engine none, nenhum runtime fence e paridade de stdout, stderr e status com Node; executam o binário com auditoria de heap. Cobrem zero/um/vários argumentos, readonly, defaults, spreads, cópias frescas, mutação posterior ao spread, ordem callee/argumentos, closures com captura, retorno de função, recursão, especialização genérica e callbacks guardados em arrays/records/classes/namespaces. Quatro testes de IR verificam identidade, recusa dos adaptadores não implementados, serialização e validação de closures.

O snapshot function-forms conserva a recusa independente de função aninhada com default sem contexto; suas duas recusas de rest foram removidas. A investigação não foi usada como justificativa para retirar a recusa restante.

## Limpeza solicitada durante a validação

A inspeção encontrou 145 GiB de temporários Rust em /home e 17 GiB em /opt. Foram removidos 2.621 e 318 arquivos ELF, respectivamente, além do cache de compilação do runtime e dos arquivos compactados do registry Cargo. Foram preservados os fontes, toolchains, configurações, resultados dos experimentos e fontes Rust gerados. A medição do filesystem indicou liberação de aproximadamente 140,4 GiB em /home e 16,2 GiB em /opt; os primeiros testes seguintes recompilaram o runtime com cache frio. Manifesto: /tmp/scriptc-cargo-cleanup-20260914.json.

Resultados verificados nesta rodada:

- Seleção ampliada: 36 testes aprovados e uma divergência esperada de snapshot em component-fences, exclusivamente pela remoção dos erros de rest e suas cascatas. Após atualizar esse snapshot, toda a suíte de diagnósticos passou: 121/121. Logs: /tmp/scriptc-typed-rest-focused.log e /tmp/scriptc-typed-rest-diagnostics.log.
- Configuração sanitized focada: 8/8. Inclui os dois novos corpus em C com sanitizadores, os dois diferenciais Rust sem engine e quatro contratos de IR. A configuração SCRIPTC_SAN=1 não instrumenta o runtime Rust com ASan. Log: /tmp/scriptc-typed-rest-sanitized-focused.log.
- Build TypeScript aprovado; lint dos arquivos alterados sem erros após a correção do harness de namespace. Os grandes arquivos existentes conservam avisos anteriores. Limites de tamanho e git diff --check aprovados. Logs: /tmp/scriptc-typed-rest-build-final.log e /tmp/scriptc-typed-rest-lint-final.log.

## Redcode original

A compilação do Redcode original encerrou por recusa controlada em 273,77 s, com pico de 4,839 GiB, sem timeout, OOM, SC0001 ou SC9001. O perfil permanece experimental: uma CPU, GOMEMLIMIT=4GiB, limite alto de 7G, máximo de 8G e nenhum swap. Houve validações concorrentes; a medição não prova ganho de velocidade nem representa execução de um binário.

O total passou de 3.087 para 3.078 diagnósticos. A comparação de código/localização removeu 21 ocorrências e acrescentou 12, agora em trechos antes bloqueados: dois filtros com type predicates escritos, Object.values, oito instanciações de optional chaining sobre subuniões e uma atribuição de união de dicionários. As mensagens que apontam rest passaram de 16 para duas; as duas restantes envolvem a união Record<string, unknown> | HeadersInit | undefined, cujo array não tem a representação exigida. Essas contagens não equivalem a bugs independentes resolvidos.

Os 1.335 textos-fonte finais conservaram ordem e hashes. Os hashes das fontes do compilador, dos arquivos rastreados do consumidor e dos arquivos físicos do grafo anterior não mudaram durante o experimento. O consumidor não foi adaptado. O resultado ainda não é um binário Redcode.

Metadados resumidos em typed-rest-function-values.json. Captura completa em /tmp/scriptc-redcode-typed-rest-20260914a, incluindo build.json, execution.json, comparison-final.json, hash-check.json, source-capture.json e phases.jsonl. Comparador: /tmp/scriptc-redcode-depth-isolated-20260914d.

Os próximos contratos de linguagem expostos por esse avanço são refinamento seguro de filter com predicado explícito e optional chaining sobre uniões de records/classes. A conversão entre convenções de callback fixas, variádicas e dinâmicas ainda precisa de adaptadores próprios antes de ampliar essa admissão.

## Gates gerais e estado do checkpoint

Os gates locais completos foram executados com bail=1 e continuam vermelhos: plain encerrou com 8 aprovados e uma falha de library-contract em C por símbolos scr_jsval_* ausentes; sanitized encerrou com 12 aprovados e uma falha do piloto statuses em C por Proxy/Symbol nativos não suportados. As duas falhas constam dos logs do checkpoint anterior (/tmp/scriptc-undici-boundary-full-sanitized.log e /tmp/scriptc-undici-boundary-full-plain.log, respectivamente). Portanto não houve aprovação de release nem afirmação de equivalência de toda a linguagem. As credenciais Sandbox indisponíveis continuaram motivando o fallback local.

Logs desta rodada: /tmp/scriptc-typed-rest-full-plain.log, /tmp/scriptc-typed-rest-full-sanitized.log e /tmp/scriptc-typed-rest-gates.json. Os testes novos permaneceram aprovados na seleção própria; a validação geral interrompida por bail não é uma execução de todas as regressões Rust do repositório.
