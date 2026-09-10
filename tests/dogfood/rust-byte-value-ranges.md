# Valores de bytes como índices inteiros

Experimento no backend Rust: uma variável local imutável inicializada por
leitura de `Uint8Array` tem intervalo conhecido 0..255 quando o getter retorna.
A análise de regiões preserva esse intervalo e mantém a variável e sua
aritmética exata em i64. Observações TypeScript continuam sendo `number`.

A leitura permanece no ponto da declaração, executada uma vez. Não se move
um getter que pode lançar ou avaliar um índice com efeitos. Locais mutáveis,
TDZ, capturados e leituras de arrays de ponto flutuante não recebem essa prova.
A aritmética que pode produzir -0 ou ultrapassar os inteiros seguros continua
usando o caminho numérico anterior.

Quando já existe um slice emprestado e o índice tem representação inteira,
`bytes_region_get_u8_integer` retorna o inteiro diretamente, com `i64::from` e
acesso verificado por `get(...).expect(...)`. Nenhuma operação unsafe foi
introduzida. Outros getters preservam sua execução original; o resultado
0..255 é convertido uma vez na declaração.

## Primeira tentativa descartada

A primeira versão convertia o retorno f64 do getter para i64 em todos os
caminhos. Os testes passaram, mas a IR otimizada manteve a conversão saturada
entre o load u8 e a aritmética inteira. Sete amostras mostraram piora:

| Mediana | Rust anterior | Cast na declaração | Bun compilado |
|---|---:|---:|---:|
| Execução (ms) | 860,92 | 956,60 | 861,13 |
| CPU (s) | 0,84 | 0,94 | 0,83 |
| Pico RSS (KiB) | 111.100 | 111.160 | 140.228 |
| Executável (bytes) | 4.070.096 | 4.070.128 | 81.413.600 |

A variante ficou 11,1% mais lenta na mediana. As 24 saídas coincidiram.
Não é ganho consolidado. Fonte e executável preservados em
`/tmp/scriptc-byte-values-20260909/cast-variant/` e `redwall/program`;
benchmark em `measurements-seven/benchmark.json`.

## Validação da leitura inteira direta

- 10 testes unitários focados do emissor passaram.
- 14 programas diferenciais de regiões/bytes passaram contra Node no Rust.
- O corpus novo 3136 também passou em C e LLVM com sanitizers; cobre views,
  offsets, paleta opcional, limites fracionários, efeitos no índice, snapshots
  de leituras, mutação, observações de -0/NaN/Infinity e arrays Float64.
- Runtime Rust 1.98.0: 217 testes e Clippy com warnings negados passaram.
- Build do workspace e limite de linhas passaram.

A build `direct-redwall/program` passou os 38 contratos do renderer, incluindo
26 chamadas nativas comparadas byte a byte. Todos os 116 hashes dos fontes do
consumidor são iguais aos da etapa anterior; engine none, FFI externa false,
zero fences. O runtime mudou apenas para acrescentar o getter inteiro e seu teste.

A IR otimizada da leitura direta contém `load i8` seguido de `zext i8 ... to i64`
antes da multiplicação por 3. Nos dois caminhos que emprestam os pixels, o byte
não passa por f64. O corpo que inclui as variantes de toRgba tem 45 chamadas
estáticas de conversão saturada contra 46 no controle e 47 na tentativa com cast;
esta contagem inclui caminhos alternativos e não é frequência de execução.
As regiões filtered/unfilter não mudaram nesse levantamento. Arquivos:
`direct.ll`, `direct-toRgba-0.ll` e `direct-llvm-summary.json`.

Sete amostras da leitura direta: mediana 1.127,86 ms contra 1.171,73 ms do Rust
anterior e 970,33 ms do Bun. Redução observada de 3,7%, 6/7 pares favoráveis
contra Rust anterior e 24 saídas idênticas. A repetição com 11 amostras confirmou a direção:

| Mediana | Rust anterior | Leitura inteira direta | Bun compilado |
|---|---:|---:|---:|
| Execução (ms) | 1.172,76 | 1.098,08 | 903,15 |
| CPU (s) | 1,16 | 1,09 | 0,89 |
| Pico RSS (KiB) | 111.072 | 111.128 | 144.336 |
| Executável (bytes) | 4.070.096 | 4.070.064 | 81.413.600 |

A candidata venceu o controle em 9/11 pares: redução de 6,4% na mediana de
tempo e 6,0% na de CPU. O executável encolheu 32 bytes; a RAM ficou estável.
As 36 saídas, incluindo aquecimentos, foram idênticas. A candidata ainda levou
1,216× o tempo do Bun nesta rodada, vencendo Bun em 4/11 pares. Não comparar
esses tempos absolutos com rodadas anteriores: o host é compartilhado.

A leitura inteira direta foi mantida neste checkpoint. Evidência da repetição:
`direct-measurements-eleven/benchmark.json`; a primeira rodada de sete amostras
está em `direct-measurements-seven/benchmark.json`. Todas as compilações próprias
terminaram antes das medições. Flags, inputs e hash do executável Bun não mudaram.
O gate completo plain/sanitized permanece separado e não está aprovado.
Evidências: `/tmp/scriptc-byte-values-20260909/`.
