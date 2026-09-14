# Conversão de erros no Rust nativo

## Causa e correção

O corpus 2164-js-then-dyn-handler.cjs reproduziu uma divergência em uma rejeição de Promise: Node imprime caught Error: nope e o Rust imprimia caught [object Object]. A Promise e o catch preservavam o erro; a conversão String(error) passava por sc_dyn_string_coerce_js, cujo fallback de objeto ignorava a conversão builtin já disponível para erros.

O fallback de ToPrimitive agora reconhece a identidade dos erros boxed e usa a formatação existente, tanto no hint string quanto no caminho numérico/default usado por concatenação. Objetos comuns não se tornam erros por declarar campos name, message ou o marcador interno. Métodos próprios toString/valueOf continuam tendo precedência e recebem o mesmo objeto como this.

O teste de interação também revelou que a interpolação dinâmica usava sc_dyn_to_string diretamente e ignorava toString próprio. Os caminhos toString da IR e jsOp.toStr agora usam a mesma conversão com hooks, e a análise de capacidades habilita o dispatch necessário. A chamada explícita String(Symbol) conserva sua regra própria; a conversão implícita continua recusando Symbol.

## Evidência diferencial

O teste original falhou antes da alteração. O teste de interação reproduziu [object Object] em String e concatenação e ignorou toString próprio na interpolação. Depois da correção, os quatro testes de emit-rust-dynamic-error-subclass.test.ts passaram: os corpora 1554, 1431 e 2164 e o novo teste de interação. Todos exigem Rust sem engine e nenhuma runtime fence; Node e Rust precisam terminar com sucesso e produzir stdout/stderr iguais. O processo Rust roda com SCRIPTC_RUST_HEAP_AUDIT=1.

O teste de interação inclui TypeError, RangeError sem mensagem, nome vazio, conversão String, interpolação, concatenação, precedência de valueOf, receiver de toString e um objeto comum com marcador de erro forjado. O primeiro rascunho do teste não chegou à execução por erros de sintaxe do template e depois por logs de resultados any não admitidos; os logs foram explicitamente convertidos a string para testar a operação pretendida. Isso é um fixture de teste, sem alteração de código consumidor.

Logs: /tmp/scriptc-rust-error-coercion-{red,expanded-red,hooks-red,green}.log. O build TypeScript, limites de fontes e git diff --check passaram; ESLint teve zero erros e dois avisos preexistentes de non-null assertions em function-values.ts.

## Bloqueio seguinte da suíte

O grupo de protótipos dinâmicos passou a chegar ao corpus 1703-arguments-rest-props.cjs e encontrou uma recusa SC1090 para a chave computada field de tipo any. A mesma recusa foi reproduzida no checkpoint congelado 63624e7a, antes desta correção, com o mesmo stdout parcial e exit 1. Trata-se de outro bloqueio de linguagem, não de uma regressão atribuível a esta mudança. Artefatos: /tmp/scriptc-computed-key-baseline.{json,log}.

Quatro testes focados verdes não significam conclusão do contrato de linguagem; os resultados dos gates gerais estão abaixo.

A seleção focada também passou com SCRIPTC_SAN=1: quatro testes, Rust nativo sem engine e sem runtime fences. Essa configuração não adiciona ASan ao runtime Rust. Log: /tmp/scriptc-rust-error-coercion-sanitized.log.

A investigação da chave computada localizou duas conversões duplicadas em lower-exprs.ts: aceitam f64/bool/dyn, mas recusam jsval, a representação produzida para o parâmetro sem anotação no fixture JavaScript. O helper ensureString existente já representa jsval como jsOp.toStr, mas uma correção de chaves precisa preservar ToPropertyKey (incluindo símbolos) e a ordem chave/valor, em vez de aceitar qualquer entrada por coerção indiscriminada. Esse é um próximo passo do núcleo de linguagem; não exige adaptar bibliotecas consumidoras.

## Validação ampliada

A seleção completa de emit-rust.test.ts, emit-rust-dynamic-error-subclass.test.ts e emit-rust-dynamic-array-tostring.test.ts terminou com 112 testes aprovados e uma falha em 724,47 s. A única falha é o corpus 1703 de chaves computadas, reproduzida no checkpoint anterior. O grupo que a contém interrompe seu laço ao falhar; portanto, os fixtures posteriores desse grupo não são cobertos por esse resultado. Não foi observado outro erro nessa seleção. Log: /tmp/scriptc-roots-coercion-rust-suite.log.

O gate geral plain, com --bail=1, terminou em 631,00 s com 100 testes aprovados, 33 skips e a mesma falha. Ele não completou as demais suítes nem substitui o gate integral verde. Nesta ordem de execução não chegou à falha C de library-contract documentada no checkpoint anterior. Log: /tmp/scriptc-roots-coercion-full-plain.log.

O gate geral sanitized, também com --bail=1, terminou em 374,14 s com 69 testes aprovados e a mesma falha do corpus 1703. Nesta execução a suíte Rust veio primeiro; o gate não chegou aos contratos de biblioteca C/LLVM. Os dois gates gerais permanecem vermelhos e não autorizam declarar release ou contrato de linguagem concluído. Log: /tmp/scriptc-roots-coercion-full-sanitized.log; códigos terminais: /tmp/scriptc-roots-coercion-full-gates.json (plain=1, sanitized=1).
