# Estado do fork e próximos passos — levantamento de 30/09/2026

## Objetivo

Registrar o estado verificado do fork após duas semanas de trabalho concorrente (Codex do mantenedor, Workers AFK e sessões Claude Code), para que qualquer agente que entre no repo parta de fatos medidos em vez de memória de sessão. Todo número abaixo foi medido em 30/09/2026 contra `origin/main`, não inferido.

## Cobertura do levantamento

- Claude Code: três sessões registradas para o scriptc, duas nas últimas duas semanas. O último trabalho substantivo dessa via foi 02–03/09 (PRs #12 a #21).
- Codex: uma thread longa de 26 a 29/09, com 37 turnos, 47 prompts e 524 alterações de arquivo.
- Lacuna de registro: o período de 09 a 25/09 não aparece no histórico de nenhuma das duas ferramentas. Esse trabalho chegou por outra via, provavelmente Workers do daemon `redskilled`. O git é o único registro confiável do período.
- Git: 166 commits entre 15 e 29/09, com atividade em todos os dias.

## O que as duas semanas produziram

A missão estreitou. A diretriz do mantenedor em 26/09 é que o fork desenvolve somente a lane Rust, com C e LLVM entrando apenas por sincronização fiel do upstream. Isso está formalizado em `2026-09-26-backend-libcall-parity.md` e passou a valer como limite de escopo para qualquer trabalho no fork.

A sincronização do upstream v0.1.6, entre 24 e 26/09, trouxe cerca de sessenta PRs da Vercel — sobretudo lowering estático de String, Array, Number e Object — e foi seguida de um dia inteiro de reconciliação do fork Rust. Essa integração revelou 52 libcalls órfãs no backend Rust.

As cinco ondas de implementação dessas 52 libcalls foram entregues em 26/09: zlib com oito chamadas, crypto com dezesseis, EventEmitter flexível com duas, child stdin mais execFile com dez, e fork/IPC com dezesseis.

Entre 27 e 29/09 o trabalho foi o tier dinâmico do Rust: sets e maps dinâmicos, famílias de closure, normalização Unicode, leituras globais de RegExp, identidade de classe através de `unknown` e preservação de `Error.cause` em subclasses.

O alvo de dogfooding avançou de tuiuiu para redcode. Em 29/09 entrou a compilação ponta a ponta do pacote codemode do redcode, incluindo um kernel Effect com HttpClient e a conversão de JsonSchema portada nativamente.

## Estado medido em 30/09

Verde: `cargo test` do runtime Rust com 260 testes passando, contra 142 em 03/09. O `#![forbid(unsafe_code)]` continua na primeira linha do crate, e o `unsafe` exigido pela API de escopo do V8 está confinado no crate irmão `packages/island-v8`, o que preserva a garantia do runtime principal. Todos os geradores estão em dia: `backend-libcalls` com 1289 spellings e zero órfãs, manifesto de ilha com 54 módulos, e o snapshot de compatibilidade com 4690 linhas de origem sobre o Node 24.15.0.

Vermelho: `cargo clippy --all-targets --locked -- -D warnings` acusa 23 erros, o que deixa o gate `runtime_rust` declarado no AGENTS.md em estado vermelho. São achados mecânicos concentrados em arquivos recentes — `schema.rs` com onze ocorrências de auto-deref explícito, `arrays.rs` com seis, `json_schema.rs` com três, `effect_http.rs` com duas e `regex.rs` com uma.

Aberto: a Onda 6 do plano de libcall parity nunca rodou. Os critérios de regeneração já estão satisfeitos, mas o corpus diferencial por família, os testes focados, a lane sanitizada e o gate completo continuam pendentes, por decisão explícita de deferir testes durante as ondas de implementação. Isso significa 52 libcalls em produção sem prova diferencial.

## Próximos passos, em ordem de prioridade

1. Zerar os 23 erros de clippy. Enquanto o gate declarado do runtime está vermelho, nenhum outro sinal é confiável.
2. Executar a Onda 6: corpus diferencial das 52 libcalls, uma família por commit. IPC precisa de fixtures parent e worker; aleatoriedade de crypto testa invariantes e não bytes específicos; toda callback precisa de prova de disparo único. O objetivo declarado é encontrar bugs nas implementações, não apenas produzir verde.
3. Rodar `pnpm test:sandbox`, que agora existe e conclui em cerca de quatro minutos. Ele substitui as lanes locais de várias horas que sofriam com OOM e contenção nesta máquina.
4. Retomar o dogfooding nos alvos restantes, `red-dev` e `red-skills`, agora que redcode compila.

## Pegadinhas operacionais desta máquina

- Os wrappers de shell para `pnpm` e `cargo` são quebrados; use os binários reais sob `~/.local/share/mise/installs` e `~/.cargo/bin`.
- O host roda Node 26, enquanto o oráculo primário do repo é o Node 24.15.0. Rodar suítes sob o Node errado produz vermelhos falsos de versão.
- `/tmp` é varrido durante builds longos e o cache de objetos de teste é global entre worktrees. Isole `TMPDIR` e `SCRIPTC_CACHE_DIR` por worktree.
- Não rode gates longos sob `pnpm limit` ou `systemd-run`: o limite de 3 GiB provoca OOM-kill de `rustc`.
- Nunca canalize logs de suíte por `grep`: o block-buffering faz uma execução viva parecer morta.
