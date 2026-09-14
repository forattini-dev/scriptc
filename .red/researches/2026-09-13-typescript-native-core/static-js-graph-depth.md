# Grafo completo de JS admitido para compilação estática

## Reprodução e isolamento

No checkpoint 9015f9e0, a análise do Redcode alternava a inclusão de 51 arquivos JS internos de undici@8.3.0. A reprodução foi antecipada para a primeira criação real do programa, antes de diagnósticos semânticos ou lowering. Seis processos novos com as mesmas oito raízes ordenadas e as mesmas opções produziram quatro grafos de 4.221 arquivos e dois de 4.170. Os hashes dos arquivos comuns eram iguais. A única diferença era carregar 52 arquivos de undici ou apenas seu index.js.

Três hipóteses orientaram as sondagens: limite de profundidade JS dependente da ordem de visita; respostas da camada de tipos/fontes dependentes da ordem; ou alteração de entradas de resolução. Foram capturadas as respostas dos callbacks do filesystem no canal privado da API TS7, somente no runner diagnóstico. Duas capturas com grafos diferentes tinham 30.262 consultas comuns e nenhuma resposta diferente; não houve respostas contraditórias para uma mesma consulta durante cada captura.

Um replay sem npm-static, reescrita ou aquisição de tipos reutilizou essas respostas capturadas. A variante totalmente congelada responde consultas não capturadas com regras determinísticas em memória: existência derivada de conteúdo já capturado, ausência para leituras desconhecidas e estruturas vazias para diretórios desconhecidos. Somente o tsconfig virtual é fornecido pelo host novo. Não há fallback ao disco para as consultas do grafo. Em seis servidores novos, houve dois grafos de 4.221 fontes e quatro de 4.170. Isso isola a variação na construção do programa do checker sob esse limite, sem atribuí-la a mudanças no consumidor ou na nossa camada de tipos. O replay é uma redução do filesystem observado, não um snapshot físico integral das dependências.

Aumentar somente maxNodeModuleJsDepth de 4 para 8 produziu grafos de 4.294, 4.294 e 4.295 arquivos. Os 110 arquivos de undici ficaram presentes, mas a variação passou para @opentelemetry/api/build/src/platform/node/globalThis.js. Substituir o corte por Number.MAX_SAFE_INTEGER produziu 4.295 arquivos nas três capturas, com o mesmo conjunto. A configuração maior é uma contraprova de admissão completa, não uma alegação de menor custo da análise.

## Reprodução reduzida

Um projeto de sete arquivos reproduziu a mesma família de falha em 30 servidores novos. O entrypoint importa duas cadeias de declarações que convergem para um pacote JS compartilhado; seu index.js requer child.js. Com profundidade 4, houve oito grafos com seis arquivos e 22 com os sete arquivos. Não usa Redcode, undici, reescrita de fontes nem uma engine JS.

Uma cadeia de declarações mais longa reproduziu a omissão de forma determinística no loadProgram real: a implementação do pacote explicitamente admitido não entrava no programa. Esse é o caso de regressão versionado, acompanhado de caminhos curtos/longos em ambas as ordens e de um ciclo entre os arquivos JS. Sem npm-static, o teste exige que a admissão histórica permaneça limitada.

O diferencial nativo acrescenta sete pacotes JS com implementações reais e declarações públicas, todos explicitamente admitidos. Antes da correção, compile() recusava depth4 dizendo que sua implementação exigia a engine embutida. Depois, a inferência atravessa a cadeia inteira, Rust compila sem engine e sem runtime fences, e Node/Rust retornam sucesso com stdout/stderr idênticos. A saída esperada é 13; o processo Rust roda com auditoria de heap habilitada.

## Implementação

loadProgram7 usa Number.MAX_SAFE_INTEGER como profundidade do checker somente quando npm-static está ativo. Esse é o maior inteiro exato disponível no lado JavaScript e aceito pelo checker; retira o corte prático arbitrário de quatro níveis. Ciclos terminam pela identidade dos arquivos. A política de pacotes selecionados, as recusas de dependências não admitidas e os stubs da camada de filesystem continuam responsáveis pela fronteira de compilação estática. O ramo sem npm-static não altera essa opção.

Não se substituem corpos executáveis por declarações, não se modifica o Redcode e não se adiciona engine. O checker passa a poder visitar fontes que antes eram truncadas; isso pode aumentar a memória, o tempo e os diagnósticos corretos. As medidas precisam usar o grafo completo antes de estabelecer metas de performance.

## Evidências locais

Os dois testes novos falharam antes e passaram após a mudança. Logs: /tmp/scriptc-undici-depth-{red,native-red,green}.log. Runners e capturas diagnósticas estão isolados em /tmp/scriptc-undici-graph-20260914: probe.mjs, replay.mjs, minimal.mjs, minimal-loaded.mjs, repeat-*.json, capture-*.json.fs.json, frozen-fs.json, replay-frozen-results.json, depth8-*.json e unbounded-*.json. Nenhuma instrumentação de callbacks foi adicionada ao código de produção.

## Fronteira de dependências não admitidas

A primeira análise completa apenas com o corte removido terminou em 479,79 s e pico de 5,19 GiB, refused, com os mesmos 3.087 diagnósticos finais e nenhum binário. O custo intermediário cresceu: a primeira consulta semântica retornou 39.589 diagnósticos, dos quais 33.812 vinham de sass/sass.dart.js. Sass não está entre os 34 pacotes admitidos. Seu package.json declara types/index.d.ts, mas exports encaminha esse acesso apenas para runtime JS. O teste anterior packageIsUntyped tomava a mera existência de metadata de tipos como garantia de que o checker nunca pediria o JS; essa premissa era falsa.

Uma reprodução separada mostrou a violação de isolamento: um import sem declarações alcançáveis, explicitamente tolerado com @ts-ignore no fixture, contribui any sem npm-static; admitir outro pacote fazia o corpo JS desse import passar a contribuir string e criava TS2322 no consumidor. As três variantes .js/.cjs/.mjs falharam antes da segunda correção. A contraprova no callback do runner preservou os tipos do consumidor. Não foi adaptado nenhum consumidor real.

A camada de filesystem agora serve o stub any já existente para implementações JS não admitidas que o checker tentar ler em node_modules, independentemente de claims de tipos em outros caminhos do pacote. Declarações alcançáveis continuam sendo lidas normalmente. Foram removidos a heurística de metadata e seu cache; a decisão de qual declaração um specifier alcança fica com a resolução do TypeScript. O tratamento agora inclui .mjs. O stub continua sendo exclusivamente uma visão de tipos, não uma implementação executável nem autorização de compilação estática.

Os testes exigem três comportamentos: sem opt-in e com somente outro pacote admitido, os tipos do consumidor permanecem iguais; quando o pacote passa a ser explicitamente admitido, o corpo real deve expor o erro string/number; quando exports passa a tornar sua declaração alcançável, o consumidor deve receber o tipo boolean declarado, inclusive com outro pacote admitido. Depois da correção, as três variantes passaram, junto dos testes de grafo e do diferencial Rust de sete pacotes: cinco testes focados aprovados. Logs: /tmp/scriptc-undici-nonopt-tests-red.log e /tmp/scriptc-undici-boundary-green.log.

A tentativa intermediária está em /tmp/scriptc-redcode-depth-unbounded-20260914a. Seus hashes de compiler, consumidor e grafo anterior permaneceram iguais durante a execução. Os runs finais são novas capturas: não se compara esse custo de uma fronteira incorreta como prova isolada de otimização geral.

## Validação intermediária e contraprovas

Com apenas a primeira correção, a seleção npm/lifecycle/TS7 terminou com 108 aprovados e quatro falhas em 15 arquivos. Três falhas C (statuses com recusa SC3001 para Proxy/Symbol; bundles 2466-getter-star e 2556-toesm-external com símbolos scr_jsval ausentes) se reproduziram no checkout congelado 63624e7a, anterior às duas mudanças. A quarta foi timeout de 120 s no diferencial statuses/Rust durante validação concorrente; o caso isolado passou em 13,45 s sem aumentar o limite. Não se atribuiu o timeout à correção sem evidência. Logs: /tmp/scriptc-undici-depth-npm-suite.log, /tmp/scriptc-undici-npm-c-baseline.log e /tmp/scriptc-undici-statuses-rust-recheck.log.

Os gates intermediários plain e sanitized, com --bail=1, pararam no mesmo contrato de biblioteca C já documentado no checkpoint anterior, cada um com oito aprovados e uma falha. Duraram 413,04 s e 182,32 s. Não são gates verdes nem validação final da segunda correção. Logs: /tmp/scriptc-undici-depth-full-{plain,sanitized}.log.

## Validação da implementação final

Os cinco testes focados passaram em plain e na configuração SCRIPTC_SAN=1. Essa configuração não instrumenta o runtime Rust com ASan. O diferencial de sete pacotes exige execução nativa com heap audit e compara stdout, stderr e exit status com Node. O build TypeScript passou; ESLint terminou sem erros, com 19 avisos preexistentes em program.ts. Os demais arquivos alterados não introduziram avisos. Limites de fontes e git diff --check passaram.

A seleção final npm/lifecycle/TS7 terminou com 112 testes aprovados e três falhas C, em 15 arquivos, em 356,30 s. São as três falhas reproduzidas no baseline 63624e7a; o diferencial statuses/Rust passou na seleção em 20,24 s. Log: /tmp/scriptc-undici-boundary-npm-suite.log. Os casos cobrem também tipos terceiros, exports de tipos, workspaces, subpaths, atribuição de erros de callbacks, seleção explícita, modo auto e o kernel Effect existente. Não se afirma cobertura integral do backend Rust nem do contrato de linguagem.

O gate geral final plain parou com --bail=1 na recusa C de Proxy/Symbol do piloto statuses: 12 aprovados e uma falha em 95,10 s. O sanitized parou no contrato de biblioteca C com símbolos scr_jsval ausentes: oito aprovados e uma falha em 125,42 s. Ambos os bloqueios já foram reproduzidos antes desta mudança. Os gates continuam vermelhos e não autorizam publicação. Logs: /tmp/scriptc-undici-boundary-full-{plain,sanitized}.log; códigos terminais em /tmp/scriptc-undici-boundary-full-gates.json.

Logs dos demais checks: /tmp/scriptc-undici-boundary-{green,sanitized-focused,build,lint-final}.log. O primeiro lint da segunda correção identificou um import que ficou sem uso após remover a heurística; o import foi removido e o lint final passou.

## Três análises completas com a implementação final

As três execuções sequenciais do Redcode original usaram uma CPU, GOMEMLIMIT=4GiB, MemoryHigh=7G, MemoryMax=8G, nenhum swap e timeout de 600 s. O orçamento Go foi aplicado apenas ao ambiente experimental, não virou configuração padrão do scriptc. Houve validação concorrente em cgroups separados; não são benchmarks de um executável nem pares alternados para afirmar ganho percentual causal.

| Execução | Tempo de compile() | Pico do cgroup | Textos-fonte finais | Diagnósticos finais |
| --- | ---: | ---: | ---: | ---: |
| b | 283.20 s | 4.774 GiB | 1335 | 3087 |
| c | 291.61 s | 4.796 GiB | 1335 | 3087 |
| d | 224.18 s | 4.963 GiB | 1335 | 3087 |

Todas retornaram refused, sem timeout, sem SC0001 e sem binário. Os códigos/localizações dos 3.087 diagnósticos permanecem iguais aos do checkpoint anterior. Os 1.335 textos-fonte finais têm os mesmos caminhos, a mesma ordem e os mesmos hashes nas três execuções. Também são iguais os conjuntos de arquivos de todas as seis criações de programas relevantes: 4.290, 4.301, 4.300, 4.225, 4.236 e 4.235 fontes. As duas sondagens descartáveis de uma fonte usam nomes temporários e são excluídas dessa comparação de caminhos.

Os registros de entrada são idênticos entre as três execuções. A conferência antes/depois preservou 488 fontes TS do compiler, 6.848 arquivos versionados do consumidor e 4.348 arquivos físicos da união dos grafos anteriores. Não houve alterações nessas entradas; high/max/oom/oom_kill ficaram zerados nas últimas amostras. A memória é o pico do cgroup de Node mais checker, não apenas o RSS do Node. Esses registros não são um snapshot físico de todos os arquivos instalados nem de todos os binários da máquina.

O aceite de três análises completas, cada uma abaixo de 600 s e 6 GiB, foi atingido nesse perfil controlado, agora com o mesmo grafo. Isso não prova a mesma memória na configuração padrão sem orçamento Go e não elimina a necessidade de otimizar as rodadas de análise: a implementação ainda cria duas cargas principais do projeto. Não há redução de bloqueios de linguagem do Redcode demonstrada por essa métrica; são 3.087 ocorrências, com cascatas, não 3.087 causas independentes.

Os resultados compactos e digests agregados estão em [static-js-graph-depth.json](static-js-graph-depth.json). Capturas completas: /tmp/scriptc-redcode-depth-isolated-20260914{b,c,d}, com before.json, build.json, execution.json, hash-check.json, comparison-final.json, phases.jsonl, source-capture.json e memory.jsonl. O campo baseline legado de build.json foi herdado do runner antigo; experiment.json identifica o comparador real. Nenhum consumidor foi reescrito e nenhuma engine foi habilitada.
