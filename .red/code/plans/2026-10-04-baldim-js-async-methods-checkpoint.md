# Baldim e métodos assíncronos de classes JavaScript

Em 4 de outubro de 2026, scriptc passou a coletar métodos async de classes JavaScript em famílias sem overrides, usando a infraestrutura assíncrona já existente. O rebuild offline do Baldim original caiu de seis para cinco diagnósticos: a recusa de client.destroy desapareceu. O consumidor continua sem binário; os testes menores de métodos assíncronos não qualificam a destruição nem operações S3 do pacote completo.

Esta etapa continua [o checkpoint do ClassBuilder](./2026-10-03-baldim-class-builder-checkpoint.md). Rust permanece stable 1.98.0. Node 26 é o foco, com o executável disponível 26.10.0, não o pin 26.8.1; Node 24.15.0 foi usado para compatibilidade secundária.

## Causa reproduzida e correção

O corpus 3435 reproduziu SC3003 com o componente SC1090 de client.destroy. Duas análises do mesmo JavaScript repetiram a recusa; uma cópia com conteúdo idêntico e extensão TypeScript não teve diagnósticos. A coleta descartava métodos async de instância em JavaScript antes de registrar a assinatura, embora a infraestrutura de Promise, receiver this e chamadas diretas já funcionasse para TypeScript.

A primeira alteração removeu o descarte indiscriminadamente. Os programas menores passaram, mas o rebuild real revelou cinco recusas novas de overrides no AWS e no Smithy, totalizando dez diagnósticos. Essa versão foi substituída: tornar todos os métodos coletáveis também fazia assinaturas de famílias virtuais não utilizadas interferirem na superfície síncrona do consumidor.

O helper js-async-methods.ts identifica famílias virtuais pelas declarações herdadas do checker, antes da coleta das bases. A análise inclui declarações e expressões de classes, módulos importados e subclasses que aparecem depois da base. Um método de mesmo nome em uma hierarquia independente não é confundido com um override. Métodos assíncronos de famílias fechadas seguem a coleta e as chamadas diretas existentes; os corpos continuam sujeitos à descoberta de alcance, inclusive os métodos privados e os especializados por parâmetros implicitamente any.

Famílias virtuais JavaScript permanecem adiadas. A coleta registra o nome canônico de cada método adiado para que a procura de métodos ordinários ou genéricos não caia silenciosamente na implementação da base. Chamadas em receivers não exatos também recusam quando uma subclasse pode selecionar um override async adiado. Um receiver exato da base pode continuar chamando sua implementação síncrona. Os guards anteriores de slots throw-only e Error.toString continuam ativos. Métodos async generator e nomes computados JavaScript permanecem fora do novo recorte.

Não houve mudança de IR, serialização, runtime ou emissores. O helper tem 84 linhas; as integrações ficam na coleta e na procura de métodos em lower-classes e no guard de chamadas em lower-calls. Os dois jobs CI de regressão Node 26 e Node 24 incluem os novos testes.

## Evidência de execução

Os seis novos corpus são 3435-js-async-method-lifecycle.mjs, 3436-js-async-method-inherited.mjs, 3437-js-async-method-rejections.mjs, 3438-js-async-method-implicit.mjs, 3439-js-async-method-deferred-family.mjs e 3440-js-async-method-modules/main.mjs. Eles cobrem inicialização e fechamento, prefixo síncrono e ordem de microtasks, receiver após await, métodos herdados e privados, instâncias independentes, rejeições antes e depois de uma suspensão, finally, especialização de três tipos de argumentos e importações ESM. Uma família virtual não utilizada permanece compilável; uma família independente com o mesmo nome continua executável.

js-async-instance-methods.test.ts contém 12 execuções Rust dev e release e seis fronteiras negativas. Cada execução positiva compara stdout, stderr, exit code e sinal com Node, exige engine none, externalFfi false e runtimeFences vazias, e executa com SCRIPTC_RUST_HEAP_AUDIT=1. Os dois testes unitários em js-async-methods.test.ts verificam identidade das declarações, ausência de mutação das classes pelo reconhecimento e ausência dos corpos virtuais adiados no IR validado.

A rodada Node 26 passou com 78 testes em quatro arquivos, incluindo os dez testes de retornos virtuais throw-only e os 48 testes de Error.toString nos três backends. Durou 164,10 s. A rodada Node 24 passou com os 20 testes novos em dois arquivos e durou 79,93 s; não foi uma repetição dos 78 testes. Os tempos incluem compilação nativa e não são benchmarks. Os seis corpus também passaram em C e LLVM, doze builds dev adicionais comparados byte a byte com Node 26, por captura de stdio em arquivos. O driver está em .red/tmp/js-async-method-backend-smoke-20261004.mjs.

## Rebuild do Baldim original

O build usou @baldim/adapter-s3 0.1.2 e @baldim/core 0.2.1 já instalados, backend rust, target node26, npmStatic auto, optimization dev e allowEngine false. O entry original continua sendo .red/tmp/baldim-rust-20261001-nDbseO/s3-client.ts: constrói o cliente com credenciais fictícias, taskExecutor false e useReckerHandler false, imprime a configuração e chama destroy. Não há send, CRUD, acesso AWS ou credenciais reais.

O report final é [.red/tmp/baldim-rust-20261001-nDbseO/results/s3-client-js-async-final-20261004-KAWNCT/probe.json](../../tmp/baldim-rust-20261001-nDbseO/results/s3-client-js-async-final-20261004-KAWNCT/probe.json). O build falhou em 91.478 ms, com RSS máximo de 646.392 KiB. O programa não foi gerado. A comparação com s3-client-rebuild-20261003-0YEolH confirmou as 706 fontes sem alterações ou remoções, incluindo o consumidor.

Restam quatro SC2013, uma de pino e três de subpaths de recker, além de uma SC2011 no agregado unknown passado ao JSON.stringify pelo consumidor. Não há mais SC1090 de client.destroy nem os cinco diagnósticos extras da primeira tentativa. Esse resultado mostra a remoção de uma recusa da compilação, não a execução do método destroy do Baldim completo.

As causas de fallback de pino e recker ainda precisam de nova análise de admissibilidade antes da próxima implementação. O report anterior s3-client-null-default-analysis-20261002 apontava atomic-sleep e node:dns/promises, respectivamente; os reports de build não publicam esses detalhes e não substituem uma análise atualizada. O probe permanece com o handler Recker desativado, mas o arquivo que o importa continua no grafo estático. Não houve rebuild de redwall ou redskilled nesta etapa.

## Validação e impedimentos de entrega

O build do workspace passou, incluindo compiler, CLI e cargo check do runtime Rust. ESLint dos arquivos novos passou sem warnings. git diff --check, sintaxe YAML dos 12 jobs CI, surface manifest com 667 entradas, backend libCalls com 1.299 spellings e node-compat:check passaram. Não houve mudança das tabelas de APIs, manifests de compatibilidade ou artefatos públicos; não foi necessário regenerá-los nem executar o gate do site nesta etapa.

As lanes completas plain e SCRIPTC_SAN=1 foram tentadas com um worker e bail no primeiro erro. Ambas pararam em native-toolchain.test.ts:228, com EPERM de execFileSync ao executar o primeiro programa C do teste de headers, depois de quatro testes passarem. Nenhuma completou os 420 arquivos. A plain durou 8,34 s; a sanitized durou 16,18 s, incluindo a espera pelo lock compartilhado. Não houve enfraquecimento do contrato nem adaptação do teste para declarar green. O gate de tamanho também continua vermelho com 33 violações no WIP; os ceilings não foram aumentados.

O resource limiter foi tentado e falhou por falta de acesso ao bus de usuário. Os controles efetivos foram heap Node de 1.536 MiB, um worker por runner, um job Cargo e um job nativo compartilhado; eles não equivalem a um teto rígido de RAM. Como /tmp estava cheio, os temporários usaram .red/tmp no disco. Os diretórios de execução temporários dos testes foram removidos pelos respectivos harnesses; artefatos de diagnóstico e WIP de outras sessões foram preservados.

git fetch origin main foi tentado e falhou ao abrir .git/FETCH_HEAD, porque .git é somente leitura. Não houve commit ou push. HEAD e origin/main locais tinham divergência zero, o que não comprova reconciliação atual com o remoto. Gates completos, dívida de tamanho e reconciliação continuam necessários antes de shipping.

A skill dev:diagnose determinou a reprodução antes da mudança, a comparação JS e TS, a revisão após o resultado do consumidor real e os testes de recusa. dev:context manteve os checkpoints e as regras do repositório como fontes atuais na ausência de Memory e Wiki inicializados. A revisão editorial de pages:write-page separou execução dos corpus, remoção de diagnósticos e qualificação ainda ausente do pacote completo.
