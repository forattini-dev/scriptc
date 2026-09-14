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
