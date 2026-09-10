# Regiões de leitura de bytes vindos de uniões

O backend Rust reconhece leituras de `Uint8Array` extraídas de uma variável
union estável. Em uma região comprovadamente sem escritas compartilhadas,
seleciona o armazenamento uma vez e mantém um empréstimo de leitura durante
o loop. Isso elimina clones do handle e a repetição do helper de narrowing
em cada acesso. A mudança é geral no compilador; nenhum fonte consumidor foi
modificado e nenhum nome de aplicação ou função decide a otimização.

A análise aceita `unionNarrow` direto e helpers cuja IR comprova que o caminho
de sucesso apenas retorna essa projeção. Antes do retorno, só admite testes
de tags comprovadamente falsos para a tag projetada, sem `else`. Recusa
capturas, suspensão, efeitos no caminho de sucesso e funções desconhecidas.
A análise de efeitos da região continua verificando também os callees.

A emissão testa a tag sem executar o helper que poderia lançar uma exceção.
Uma tag ausente seleciona o caminho original: uma leitura realmente executada
continua lançando seu erro no mesmo ponto; um loop vazio ou ramo não executado
não começa a falhar antecipadamente. Views com armazenamento indireto também
mantêm seus getters. Os índices continuam verificados e o runtime mantém
`#![forbid(unsafe_code)]`.

Há no máximo três variantes por região: todos os inputs especializados;
inputs diretos especializados com projeções genéricas; e acesso genérico.
A segunda preserva as otimizações anteriores quando uma paleta é nula ou
indireta. Não se emitem todas as combinações possíveis de inputs.

## Validação

- Testes do emissor verificam a prova estrutural, recusa de efeitos, estabilidade
  da IR e preservação do caminho rápido dos inputs diretos.
- Corpus `3135-native-byte-projections.ts`: null/undefined, ramo não executado,
  loop vazio, narrowing explícito, offsets, aliases, views indiretas,
  reatribuição, chamadas com efeitos e liberação após exceção. Passou contra
  Node em Rust e em C/LLVM com sanitizers.
- A rodada final focada passou 28 testes; a rodada de unitários sem filtro
  passou 15. Os demais casos anteriores de regiões também foram exercitados.
- Runtime Rust 1.98.0: 216 testes e Clippy com warnings negados passaram.
- Build do workspace passou. O gate completo plain/sanitized permanece
  separado e não está aprovado por esses testes focados.

## Evidências

Diretório: `/tmp/scriptc-palette-regions-20260909/`.
`before/` preserva os arquivos anteriores ao passo. `runtime.log`,
`final-build.log`, `fallback-tests.log`, `final-differential.log` e
`sanitized.log` registram a validação. A sonda instrumentada de paleta é apenas
um diagnóstico; seus timers não constituem benchmark do compilador integrado.

A build `final-redwall/program` passou os 38 contratos do renderer, incluindo
26 chamadas nativas com PNGs idênticos aos do Bun. Os 116 hashes dos fontes
analisados são iguais aos da etapa anterior. Engine `none`, nenhuma FFI
externa e zero runtime fences. A comparação usou sete amostras medidas e um aquecimento por candidato,
processos novos, ordem alternada, CPU fixada no núcleo 2, quota de um CPU,
3 GiB sem swap e auditoria de heap habilitada nos nativos.

| Medida mediana | Rust anterior | Projeções por região | Bun compilado |
|---|---:|---:|---:|
| Execução (ms) | 1.785,01 | 1.197,61 | 1.055,38 |
| CPU (s) | 1,76 | 1,17 | 1,03 |
| Pico RSS (KiB) | 111.320 | 111.176 | 144.568 |
| Executável (bytes) | 4.066.800 | 4.070.096 | 81.413.600 |

A candidata venceu o controle em 6/7 pares, com redução de 32,9% na mediana
de tempo e 33,5% na mediana de CPU. O executável cresceu 3.296 bytes. Contra
Bun, leva 1,135× o tempo e usa 23,1% menos pico RSS; venceu Bun em apenas 1/7
pares, portanto ainda não há vitória em execução. As 24 saídas são idênticas.

A máquina é compartilhada: os tempos absolutos não são comparáveis aos da
rodada anterior de index-regions. O controle e Bun foram medidos novamente
nesta rodada. Evidência: `measurements-seven/benchmark.json` e
`final-redwall/acceptance.json`. Não há mudança nas flags de otimização.
