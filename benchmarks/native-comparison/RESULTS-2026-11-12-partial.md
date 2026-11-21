# Mini benchmark parcial — 2026-11-12

Execução de `pwsh -File benchmarks/native-comparison/benchmark.ps1 -RuntimeRuns 7 -ScriptcOptLevel 3` no checkout de trabalho. Node v26.12.1, Bun 1.4.4, rustc 1.99.1, scriptc nativo `0.1.1-rust.0`, frontend `780dc512d64f40afebffa6a7028207649fb7ed1c`, IR 13, sem engine ou fallback. Cada modo teve uma execução de aquecimento e sete processos novos medidos. Todos os 15 modos reproduziram stdout, stderr e código de saída do Node de origem.

| Carga | Node origem (ms) | Bun executável (ms) | scriptc Rust release (ms) | scriptc memória privada (MiB) | scriptc executável (MiB) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Numérico | 102,8 | 59,6 | 61,5 | 6,24 | 3,95 |
| Registros | 103,4 | 26,4 | 56,8 | 16,19 | 0,94 |
| Map/Set | 100,9 | 38,0 | 52,4 | 6,16 | 0,92 |

No [checkpoint anterior](RESULTS-2026-11-10.md), com as mesmas versões e sete amostras release, scriptc mediu 62,4 ms, 54,8 ms e 127,3 ms respectivamente. A nova mediana de Map/Set é 58,8% menor (2,43× mais rápida); suas sete amostras variaram de 50,7 a 53,0 ms. Isso é uma comparação entre rodadas, não uma atribuição causal a uma alteração específica. Numérico e registros ficaram próximos do checkpoint.

Compilação scriptc: 97,7 s numérico, 6,9 s registros, 6,4 s coleções. A primeira compilação recompilou dependências Rust no cache compartilhado; seus 97,7 s não representam uma compilação aquecida. Os tempos de build dos outros modos e todas as amostras estão no [resultado bruto](C:/Users/filip/AppData/Local/Temp/scriptc-native-comparison-partial-20261112-29232/results.json).
