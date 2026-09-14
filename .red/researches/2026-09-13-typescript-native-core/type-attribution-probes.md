# Sondagens de tipos sem preparação para lowering

## Correção

A atribuição npm descarta cada programa sondado e consulta apenas a existência de SC0001. Mesmo assim, executava todo o preflight estrutural, incluindo prefetch de estruturas para lowering e cálculo de ordem de módulos. O teste com os pacotes safe e guard reproduziu duas chamadas de prefetch em dois programas descartáveis. Depois da mudança, continua atribuindo o erro a guard e não faz esse prefetch.

O novo módulo preflight-types.ts extrai a fase existente de configuração e tipos, incluindo registro prévio de workspaces, filtros de diagnósticos e conferência do programa sem overrides de lowering. O preflight completo continua chamando essa mesma fase antes das verificações estruturais. As sondagens de remoção individual e de pacote isolado usam somente a fase de tipos e sempre descartam o programa em finally. O programa final continua passando pelo preflight completo; tipos válidos de um host externo não se tornam uma implementação executável.

A extração reduziu program.ts de 3.253 para 2.993 linhas e index.ts de 2.416 para 2.413, com redução dos limites congelados correspondentes. Não mudou regras de tipagem, admissão de APIs, emissão Rust ou runtime.

## Validação

- Repro antes da correção: falhou com duas chamadas de prefetch. Após a correção: passou sem chamadas, preservando o pacote atribuído.
- Nove testes focados passaram em plain e em SCRIPTC_SAN=1. Incluem erros de sintaxe, nome inexistente, atribuição inválida, JSON.parse no programa original, descarte de programas e recusa estrutural de host externo. A faixa sanitized não instrumenta o runtime Rust com ASan.
- 37 testes de integração passaram; as três variantes de paridade nativa foram excluídas dessa seleção e a variante Rust foi executada separadamente.
- O diferencial Rust de dependências transitivas passou após rebuild frio do runtime: backend Rust, sem engine, stdout/stderr/status iguais ao Node.
- Build do pacote compiler, ESLint dos arquivos modificados (zero erros, 50 avisos preexistentes/movidos), limites de arquivos e git diff --check passaram.

Logs: /tmp/scriptc-core-{probe-red,probe-green,types-focused,types-integration,types-sanitized,types-build,types-eslint-final,types-rust-native}.log.

## Registros de paridade ausentes

O canário de ordem e diagnósticos encontrou cinco fixtures sem registros em seu recorte padrão de 620 entradas. A primeira falha, com três desses fixtures, se reproduziu no checkpoint 6abbe7ec. O inventário completo identificou 82 fixtures recentes ausentes, todos já existentes no checkpoint anterior.

Uma captura restrita a essas 82 entradas executou o frontend real anterior e o novo. As respostas foram idênticas nas duas versões: zero diagnósticos e ordem de módulos incluindo a entrada correspondente. Foram acrescentados somente esses 82 registros; os 1.793 registros anteriores permaneceram intactos. Não se regravou a coleção inteira a partir da implementação nova.

Os grupos com registros existentes passaram nos recortes executados (18 testes na primeira execução, 13 na segunda); os dois grupos com registros ausentes passaram depois da reposição. Essas execuções cobrem os 33 testes do recorte padrão, mas não são um resultado terminal do gate completo. Capturas: /tmp/scriptc-missing-canaries-{baseline,current}.json; logs: /tmp/scriptc-core-types-canary{,-baseline,-rest,-repaired}.log.

O gate plain de 6abbe7ec foi interrompido deliberadamente ao confirmar a ausência de registros que impediria sua aprovação. Havia concluído library-multi (31 aprovados, 33 skips) e continuava na suíte de toolchain. Não registrar a interrupção como OOM, falha do compilador ou gate aprovado. Logs: /tmp/scriptc-core-full-plain-6abbe7ec.log.

## Redcode original: tentativa g

Mesmos entrypoint original, commit consumidor b8fa0e8e31cd6dac384347f4852fc7b3c8519a86, 34 pacotes explícitos, Rust sem engine, target bun, release e limites de uma CPU, MemoryHigh=7G, MemoryMax=8G, sem swap. O código do compiler ficou congelado durante a tentativa.

Resultado: timeout de 600 segundos (exit 124; monitor 600,77 s), sem retorno de compile() e sem binário. Pico do cgroup: 6.661.054.464 bytes (6,20 GiB). Última amostra: zero eventos high, max, oom e oom_kill. Foram registradas 27 criações de programas e 13 consultas semânticas, incluindo respostas servidas pelo cache.

Hashes de 487 fontes TS do compiler, 6.848 arquivos versionados do consumidor e 4.223 arquivos do grafo anterior conferiram sem alterações. Artefatos: /tmp/scriptc-redcode-memory-20260913g/{execution.json,hash-check.json,phases.jsonl,memory.jsonl,build.json}. A conferência não é um snapshot físico de todas as dependências instaladas.

As tentativas f e g são análises incompletas, com outras validações concorrentes; seus picos de 6,50 e 6,20 GiB não justificam ganho percentual nem comparação controlada de tempo. O objetivo de três análises completas em até 600 s e 6 GiB continua aberto. O próximo diagnóstico deve registrar os conjuntos de pacotes e os chamadores de cada recarga para localizar o custo restante; a redução de prefetch isolada não resolveu o caso original.

## Validação integral de 63624e7a e captura de atribuição

O gate plain terminou com 73 testes aprovados, 35 skips e uma falha: library-contract, emissão C, no caso que verifica identidade de módulos npm. O C gerado chama scr_jsval_from_dyn/scr_jsval_binop sem a superfície correspondente no runtime de biblioteca. O mesmo teste falhou com os mesmos símbolos no baseline e50752ff, anterior às mudanças de ciclo de vida e de sondagem. Não é uma regressão introduzida por este checkpoint. O fixture original não foi adaptado para ocultar a falha.

O gate sanitized terminou com 22 testes aprovados, 35 skips e uma falha em library-multi/M2, par llvm-llvm. A execução isolada do executável retido reproduziu o status 1: LeakSanitizer apontou 96 bytes em duas alocações de scr_arr_new (64 diretos e 32 indiretos). Não foi desligado o detector de vazamentos. Essa falha ainda não foi comparada a um baseline e não foi atribuída à otimização nova. Logs: /tmp/scriptc-core-full-{plain,sanitized}-63624e7a.log, /tmp/scriptc-core-contract-c-baseline.log e /tmp/scriptc-core-sanitized-m2-probe.log. Os gates gerais permanecem vermelhos.

A captura h foi limitada deliberadamente a 240 s para diagnóstico de atribuição; não é outra tentativa do aceite de 600 s. Wrappers externos registraram stack, seleção npm e início/fim de prefetch; nenhum marcador entrou nos fontes do compiler. A primeira carga terminou sua preparação estrutural entre 76,93 e 92,96 s. Aos 97,62 s o chamador era findSingleNpmSurfaceOffender, sondando o conjunto sem @reddb-io/redcode-core; aos 157,70 s iniciou o conjunto sem @reddb-io/redcode-sdk. Essas sondagens não chamaram prefetch estrutural. Portanto, o custo restante observado está nas reanálises de tipos do programa inteiro para cada remoção individual, e não numa repetição daquele prefetch dentro da sondagem.

A captura encerrou por seu timeout de 240 s, com 11 programas criados, pico de 6.665.543.680 bytes e zero eventos high/max/oom/oom_kill na última amostra. Hashes de compiler, consumidor e grafo anterior permaneceram iguais. Artefatos: /tmp/scriptc-redcode-attribution-trace-20260913h. A solução seguinte precisa reduzir ou compartilhar essas consultas preservando a atribuição de erros e a interação entre pacotes; impor um corte arbitrário ou simplesmente retirar pacotes mudaria o contrato.

## Raízes de declaração dos workspaces selecionados

A consulta isolada de checkPreflightTypes no Redcode revelou 18 SC0001: nove erros duplicados de arquivo não encontrado para declarações configuradas que existem fisicamente, incluindo core/src/capability/shell/ssh2.d.ts, core/src/design/gifenc.d.ts, core/src/markdown.d.ts e seis sst-env.d.ts. O shadow de npm-static ocultava essas raízes ao checker; a atribuição tentava remover pacotes para resolver erros criados pelo próprio compiler.

ProjectDeclarations agora preserva no host os bytes originais das raízes de declaração explicitamente configuradas de workspaces selecionados por npm-static. Declarações com gêmeos de implementação TS/JS continuam excluídas: a fonte executável determina a assinatura inferida. A mudança não expõe indiscriminadamente as declarações distribuídas do pacote nem altera o consumidor.

O teste novo reproduziu as raízes ausentes antes da correção. Depois dela, 41 testes de integração passaram, cobrindo raízes de projeto, pontes de tipos npm, providers de terceiros e identidade de pacotes. Os oito testes de declarações também passaram com SCRIPTC_SAN=1; essa faixa não instrumenta o runtime Rust com ASan. ESLint dos dois arquivos terminou sem erros nem avisos.

A consulta inicial isolada após a correção terminou com zero diagnósticos, 4.232 arquivos e 61.537 ms. O original tinha 18 diagnósticos, 4.172 arquivos e 99.683 ms. São consultas isoladas, não builds completas nem benchmark controlado. A captura corrigida está em /tmp/scriptc-redcode-type-diagnostics-roots-fixed.json e o log em /tmp/scriptc-redcode-type-diagnostics-roots-fixed.log; o runner reutilizou o nome inicial do JSON, portanto esse arquivo inicial não conserva o resultado antigo.

A suíte Rust também reproduziu separadamente a divergência do fixture 2164-js-then-dyn-handler.cjs: String(error) retorna [object Object] em vez de Error: nope. O Rust gerado preserva o lançamento do Error e converte o catch por sc_dyn_string_coerce_js; seu fallback genérico de objeto ignora o tratamento de erros de sc_dyn_to_string. Log de reprodução: /tmp/scriptc-rust-error-coercion-red.log. Essa correção é o passo seguinte e não está incluída no ajuste das raízes.

## Redcode original após a correção das raízes

A tentativa /tmp/scriptc-redcode-workspace-roots-20260914a retornou normalmente de compile() em 155.154 ms; o monitor terminou em 160,19 s, exit 1, sem timeout. O resultado foi refused, com 3.087 diagnósticos e nenhum binário. Não confundir análise concluída com build nativa concluída. Os 34 pacotes explícitos, entrypoint original, target bun, Rust release e allowEngine=false foram preservados.

O pico do cgroup foi 7.518.179.328 bytes (7,00 GiB), com 24 eventos MemoryHigh, nenhum MemoryMax/OOM/oom_kill na última amostra. A meta de 6 GiB permanece aberta. Foram criados quatro programas e executadas duas consultas semânticas. Hashes das fontes do compiler, arquivos versionados do consumidor e grafo anterior permaneceram iguais; o retorno capturou 1.323 sourceTexts reais. Não usar as tentativas incompletas anteriores como denominador de ganho percentual.

Distribuição: SC1090=1.302, SC2013=643, SC2009=449, SC2004=288, SC2011=156, SC2020=119 e demais códigos=130. Zero SC0001. Entre mensagens repetidas estão chamadas tx.run sem lowering (205), importações de drizzle-orm que exigiriam engine (84), valores desse pacote (81), construção de classes já rejeitadas (62) e membros Effect em Plugin<Scope> (49). São ocorrências, não 3.087 defeitos independentes; há cascatas e dependências fora da seleção estática. Próxima triagem deve separar causas primárias do frontend de limites de bibliotecas sem habilitar engine para ocultá-los.

O build TypeScript do compiler, os limites de fontes e git diff --check passaram após o ajuste das raízes. Logs: /tmp/scriptc-workspace-roots-{related,sanitized,lint,build}.log. Os gates completos anteriores continuam bloqueados pelas falhas C/LLVM documentadas acima; este checkpoint não é um gate de release aprovado.
