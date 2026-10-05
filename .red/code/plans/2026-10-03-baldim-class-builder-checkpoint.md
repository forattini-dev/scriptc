# Baldim e captura do ClassBuilder

Em 3 de outubro de 2026, scriptc passou a compilar um recorte de wrappers que retornam a classe criada por um método de builder, preservando o receiver capturado e a identidade de CommandRef. As rodadas de regressão no Node 26.10.0 e no Node 24.15.0 passaram com 100 testes em 12 arquivos cada. O AWS e o Baldim originais continuam bloqueados; este checkpoint não declara um binário S3 qualificado.

Esta etapa continua [o checkpoint das factories de classes](./2026-10-03-baldim-class-factory-captures-checkpoint.md). O Rust executado é stable 1.98.0, sem nightly. Node 26 é o foco; 26.10.0 é o executável disponível, não o pin 26.8.1. Node 24.15.0 é a compatibilidade secundária.

## Recorte implementado

`class-factory-shapes.ts` separa o reconhecimento puro da reserva e inicialização de capturas em `class-factory-captures.ts`. O wrapper precisa retornar diretamente `new Builder(args).build()`, com uma classe de programa nominal, um método próprio sem parâmetros e sem dispatch presumido. O método admite `const closure = this; return class extends Base { ... };` ou `const closure = this; let CommandRef; return (CommandRef = class extends Base { ... });`. Nenhum statement adicional do builder é descartado.

Cada chamada admitida continua restrita a um único inicializador const de topo ou ao heritage de uma declaração de classe de topo. Primeiro são avaliados os argumentos do wrapper, inclusive os não usados, em ordem. Depois o construtor real do builder é executado sob essas capturas, e o receiver resultante fica em uma célula por chamada. Os métodos da classe retornada leem o mesmo receiver; a mutação de sua configuração permanece observável entre instâncias da mesma classe, mas não atravessa para o builder de outra chamada.

CommandRef ganha uma célula classval nominal por chamada, inicializada depois da criação da classe. Métodos de instância e estáticos com retorno direto desse identificador têm o ABI refinado para a classe concreta da instanciação, em vez de tentar converter o classval para o any inferido pelo JavaScript. Statements anteriores de expressão, declaração ou vazio permanecem no corpo e conservam seus efeitos; controle de fluxo com retornos alternativos não é refinado por essa regra. O nome da classe segue NamedEvaluation e é CommandRef, não o nome da classe derivada que a estende.

O fallback de leitura nativa reconhece name de um receiver que já baixou para classval mesmo quando o checker ainda diz any. A operação consome o receiver uma única vez. Uma hierarquia com shadowing de name estático conserva uma recusa explícita nesse fallback: a metadata nativa não é confundida com a propriedade mutável. Não houve mudança de IR, formato de serialização ou runtime Rust.

## Fronteiras conservadas

Chamadas repetidas dentro de funções, defaults, optional, rest, destructuring, aridade não exata, módulos CommonJS importados recarregáveis e bases ou bindings ainda em TDZ conservam os guards anteriores. A classe do builder também precisa ter sido inicializada. Overrides, campos que shadowam o método, métodos herdados, dispatch de um receiver desconhecido, chamadas diretas de build em receivers arbitrários e chains de métodos não são cobertos por este reconhecimento.

O wrapper não pode depender de this, super, arguments ou meta-properties de seu próprio frame na expressão do receiver: especializar esses nós sob o frame de topo alteraria o comportamento. Métodos com statements extras não são reconhecidos como a família fechada. Quando existe CommandRef, inicializadores e blocos estáticos da classe retornada são recusados, mesmo sem uma leitura direta do identificador: poderiam invocar indiretamente um método antes da atribuição da célula. Classes sem essa self-reference admitem inicializadores estáticos e têm evidência de execução após a construção do builder.

## Evidência de regressão

Os quatro novos corpus são `3431-js-class-builder-capture.mjs`, `3432-js-class-builder-order.mjs`, `3433-ts-class-builder-capture.ts` e `3434-js-class-builder-modules/main.mjs`. Cobrem duas classes independentes, shared receiver por classe, identidade da configuração, mutação posterior, efeito dos argumentos não usados, construção do builder antes dos estáticos, métodos estáticos que retornam CommandRef, nome da classe, efeitos de leituras computadas, herança e importação ESM da factory.

`class-factory-capture.test.ts` agora tem 22 execuções positivas dev/release e dez recusas. Cada execução positiva compara stdout, stderr, exit code e sinal byte a byte com Node e exige engine none, externalFfi false, runtimeFences vazias e auditoria do heap Rust. `class-factory-captures.test.ts` tem dois testes de IR: o novo verifica receivers e self-cells distintos, ordem de inicialização, nomes CommandRef e ausência de um corpo ordinário descartado de ClassBuilder.build. `class-factory-shapes.test.ts` tem cinco casos de reconhecimento sem registrar classes, globals ou ambiente de captura. Os dois jobs CI Node 26/24 incluem o novo arquivo unitário.

Os 39 testes desse grupo e 61 regressões anteriores totalizaram os 100 testes em 12 arquivos em cada Node. As rodadas Node 26 e Node 24 levaram 294,19 s e 319,21 s, respectivamente. Esses tempos incluem compilação nativa e não são benchmarks de desempenho. O snapshot legado de mixins passou sem atualização, com um teste executado e 130 casos fora do filtro.

Os corpus 3431 e 3433 também passaram nos backends C e LLVM, quatro builds dev sem engine ou FFI externa, comparados com Node 26 por captura de stdio em arquivos. A primeira execução do driver de smoke teve um erro de chamada do próprio harness, por omitir o array de argumentos; o driver foi corrigido e todos os quatro casos foram executados novamente e passaram.

## Reteste dos consumidores originais

Os reports finais estão sob `.red/tmp/baldim-rust-20261001-nDbseO/results/`. São probes offline de construção/configuração e destruição com credenciais fictícias, sem send, operações de bucket ou CRUD.

| Consumidor | Diagnósticos | Extends computados | Report |
| --- | --- | --- | --- |
| AWS S3Client isolado | 1.055 SC3003 | 113 | `aws-class-builder-final-20261003/probe.json` |
| Baldim adapter S3 original | 6 | 0 nos diagnósticos externos | `s3-client-class-builder-final-20261003/probe.json` |

O AWS levou 41.571 ms, com RSS máximo de 554.528 KiB. O Baldim levou 93.673 ms, com RSS máximo de 659.024 KiB. A comparação SHA-256 dos reports finais com o checkpoint anterior confirmou todas as 30 fontes AWS e 706 fontes Baldim sem alteração ou remoção. Os arrays de diagnósticos também permaneceram exatamente iguais. O Baldim mantém quatro SC2013 de pino/recker, um SC2011 do agregado unknown impresso pelo consumidor e um SC1090 de client.destroy. Nenhum dos dois gerou binário nesta rodada. Redwall e redskilled não foram reconstruídos.

## Validação e entrega

O build dos pacotes do workspace passou, incluindo compiler, CLI e cargo check do runtime Rust. ESLint dos seis arquivos novos ou pequenos de implementação/testes passou sem warnings. Os pontos de integração em lower-classes e lower-mixins passaram com zero erros e 104 warnings legados. git diff --check, sintaxe YAML dos 12 jobs CI, surface manifest com 667 entradas, backend libCalls com 1.299 spellings e node-compat:check passaram. Não houve alteração de tabelas de APIs nem de artefatos públicos de compatibilidade nesta etapa, portanto não houve regeneração nem necessidade de gate do site de docs.

As lanes completas plain e SCRIPTC_SAN=1 foram tentadas com um worker e bail no primeiro erro. Ambas pararam em `native-toolchain.test.ts:228` com EPERM de execFileSync ao executar o primeiro binário C do teste de headers, depois de quatro testes passarem. Os 418 arquivos de teste não foram completados. As lanes levaram 8,86 s e 9,58 s, respectivamente. Não houve enfraquecimento de contratos, remoção de testes ou mudança para nightly para declarar green.

O gate global de tamanho continua vermelho com 33 violações de limites ou ceilings congelados no WIP existente; a integração acrescenta linhas a lower-classes, e os ceilings não foram aumentados. Os helpers de captura e de reconhecimento têm 162 e 135 linhas. O ambiente mantém um worker de teste, um job nativo compartilhado, um Cargo job e heap Node de 1.536 MiB; o cgroup permanece indisponível e /tmp cheio, então os temporários usam .red/tmp no disco. Esses controles não equivalem a um teto rígido de RAM.

Não houve commit, push ou fetch; .git é somente leitura. Os refs locais HEAD e origin/main continuam com divergência zero no cache local, o que não demonstra reconciliação com o remoto atual. WIP anterior e locks de outras sessões foram preservados. Gates completos, redução revisada da dívida de tamanho e reconciliação com origin/main continuam necessários antes de shipping.

## Próximo bloqueio reproduzido

O SDK original usa `makeBuilder(common, service, name, ep)` para retornar makeCommand, que faz Object.assign e passa por `Command.classBuilder().ep(...).m(...).s(...).n(...).sc(...).build()`. Este recorte só reconhece o wrapper direto com new; por isso as 113 recusas de extends computado do AWS continuam presentes. O avanço no método não qualifica essa cadeia inteira.

A redução seguinte está em `.red/tmp/smithy-builder-chain-repro-20261003.mjs`, com report `.red/tmp/smithy-builder-chain-red-20261003/probe.json`. Node imprime `common first second 7` e `true false`, com exit code zero e stderr vazio. O build Rust ainda produz cinco SC3003, começando pelo SC1090 de extends computado. A redução conserva a factory de função, a captura de common, o merge de configuração e a cadeia curta classBuilder().ep(...).build().

A próxima implementação deve carregar o ambiente da função retornada, avaliar seu prefixo com Object.assign, executar cada etapa do builder sem presumir que toda chamada retorna o mesmo receiver e finalmente especializar build com uma identidade distinta por invocação admitida. Defaults e a passagem de CommandCtor dentro de objetos dinâmicos são fronteiras posteriores explícitas; o classval atual não pode ser convertido silenciosamente para dyn. Só depois do reproducer ficar green deve-se retestar a cadeia completa e os consumidores npm originais.

A skill de diagnóstico manteve a redução vermelha antes da implementação e o reteste das fontes npm. A disciplina editorial do checkpoint separa os testes que passaram, as fronteiras conservadas e os gates que continuam impedindo shipping.
