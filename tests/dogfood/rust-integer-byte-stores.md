# Escritas inteiras em regiões de bytes

O backend mantém a representação inteira também na escrita de Uint8Array
quando já conhece o índice inteiro e o valor é um inteiro JS exato, ou uma
leitura u8 direta de um slice emprestado. Isso evita converter byte/integer
para f64 e depois executar ToUint8 em cada canal da imagem.

O helper `bytes_region_set_u8_integer` usa `get_mut(...).expect(...)` e cast
inteiro para u8: para inteiros JS exatos, reter os oito bits inferiores é a
mesma operação de ToUint8, inclusive para negativos. Não aceita como prova um
float arbitrário ou uma leitura de array mais largo. A ordem emitida continua
sendo índice, valor e escrita verificada. Leituras do próprio output usam um
empréstimo temporário que termina antes da escrita mutável.

A mudança é geral no compilador/runtime. Não há nome de aplicação, transformação
textual do Rust gerado, código unsafe, alteração de flags ou fonte consumidor.

## Validação

- 19 testes focados do emissor passaram; os contratos de geração anteriores
  agora exigem explicitamente os helpers inteiros para a cópia u8 especializada.
- Os 14 corpus anteriores 3123–3136 passaram. O novo 3137 passou contra Node
  em Rust e em C/LLVM com sanitizers: valores negativos, limites de inteiros
  seguros, modulo 256, float/NaN/infinidades, views, Uint32Array, cópia dentro
  do mesmo output e ordem de avaliação com efeitos.
- O primeiro rascunho de 3137 usava Uint16Array, que tem uma recusa de frontend
  preexistente; o teste de origem mais larga passou a usar Uint32Array.
- Runtime Rust 1.98.0: 218 testes e Clippy com warnings negados passaram.
- Build do workspace, ESLint, limite de linhas e whitespace passaram.
- Redwall: 38 contratos, com 26 chamadas nativas e PNGs idênticos aos do Bun.
  Os 116 hashes dos fontes analisados são iguais aos do controle anterior.
  Engine none, FFI externa false e zero fences.

## Medições e decisão

A mudança fica retida após duas rodadas com apenas controle/candidata,
alternando a primeira posição. Cada rodada tem um aquecimento e 11 amostras
medidas por binário, com 24 saídas equivalentes:

| Rodada | Rust anterior | Escritas inteiras | Redução da mediana | Pares favoráveis |
| --- | ---: | ---: | ---: | ---: |
| `measurements-rust-pair` | 712,45 ms | 684,37 ms | 3,9% | 9/11 |
| `measurements-rust-pair-confirm` | 1.031,43 ms | 948,63 ms | 8,0% | 9/11 |

A segunda rodada teve CPU mediana 1,01 s → 0,92 s e RSS máximo mediano
111.088 → 111.104 KiB, sem redução relevante de memória. O executável diminuiu
de 4.070.064 para 4.069.456 bytes. Outra rodada, `measurements-bun-pair`,
comparou candidata e Bun compilado: 688,46 contra 684,13 ms, CPU 0,67 contra
0,66 s, RSS 111.192 contra 138.016 KiB e binário Bun de 81.413.600 bytes.
Isso não demonstra vitória estável sobre Bun em tempo de execução.

As primeiras rodadas de três casos foram contraditórias: redução de 5,5%
em sete amostras, seguida de regressão de 18,7% em 11. O harness alterna a
lista com sua inversa; com três casos, a candidata permanece no meio. Isso
motivou as comparações em pares, mas não prova a causa da contradição. O host
é compartilhado: não comparar tempos absolutos entre rodadas distintas.

A instrumentação idêntica de cópias do Rust gerado indicou `toRgba` em
102,71 → 67,40 ms e render total em 950,05 → 955,40 ms. São tempos inclusivos
de diagnóstico, sujeitos ao efeito da instrumentação. A IR otimizada do
corpo principal de `toRgba` reduziu chamadas estáticas fptosi.sat de 45 para
34 e uitofp de 15 para 6; essas contagens não são frequências de execução.

O gate completo plain/sanitized permanece separado e não está aprovado por
esses testes focados. A missão continua aberta.
Evidências: `/tmp/scriptc-integer-byte-stores-20260909/`.
