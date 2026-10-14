#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

function latest(events, phase) { return events.findLast(event => event.phase === phase); }

/** Test verdicts remain authoritative. Build success alone never counts as
 * parity, and an engine profile alone never counts as engine-free Rust. */
export function classifyProgram(program, verdict, events = []) {
  const build = latest(events, "build");
  const execution = latest(events, "execution");
  const profile = build?.ok ? build.execution : undefined;
  const messages = verdict?.errors?.map(error => error.message ?? "").join("\n") ?? "";
  const diagnostics = build?.ok === false ? build.diagnostics ?? [] : [];
  let status = "unrun", failureKind;
  if (verdict?.state === "skipped") status = "skipped";
  else if (verdict?.state === "passed") {
    status = profile?.engine === "none" ? "passed-native" : profile?.engine ? "passed-engine" : "passed-profile-missing";
  } else if (verdict?.state === "failed") {
    status = "failed";
    // A timed-out retry may leave a build or comparison from an earlier
    // attempt. The final test timeout remains the observed failure.
    if (/Windows job resource boundary/.test(messages)) failureKind = "resource-boundary";
    else if (/^Test timed out in \d+ms\./m.test(messages)) failureKind = "timeout";
    else if (build?.ok === false) {
      failureKind = diagnostics.some(item => item.code === "SC3001") ? "rust-refusal"
        : diagnostics.some(item => item.code === "SC0001") ? "preflight-diagnostic" : "compiler-diagnostic";
    } else if (execution) {
      failureKind = !execution.stdoutEqual ? "stdout-mismatch"
        : execution.rustExit !== execution.expectedExit || execution.nodeExit !== execution.expectedExit ? "exit-mismatch"
        : execution.expectedExit === 0 && !execution.stderrEqual ? "stderr-mismatch" : "assertion-after-execution";
    } else if (/ENOENT|os error 2|could not find.*(?:executable|toolchain)|toolchain.*not installed/i.test(messages)) {
      failureKind = "environment-tool-missing";
    } else if (/timed out|timeout/i.test(messages)) failureKind = "timeout";
    else failureKind = build?.ok ? "execution-incomplete" : "compile-threw";
  }
  return {
    program, status, failureKind, engine: profile?.engine ?? null, externalFfi: profile?.externalFfi ?? null,
    target: build?.target ?? null, dynamicRequested: build?.dynamic ?? null,
    durationMs: verdict?.diagnostic?.duration ?? null, retried: (verdict?.diagnostic?.retryCount ?? 0) > 0,
    flaky: verdict?.diagnostic?.flaky ?? false, runtimeFences: build?.runtimeFences ?? [],
    diagnostics, skipReason: verdict?.note ?? null, errors: verdict?.errors ?? [],
    comparison: execution ?? null,
  };
}

export function makeMatrix(inventory, verdictRows, eventRows, metadata = {}) {
  const verdicts = new Map(), events = new Map(), unexpected = [];
  const wanted = new Set(inventory);
  if (wanted.size !== inventory.length) throw new Error("duplicate program in inventory");
  for (const verdict of verdictRows.filter(row => row.event === "result")) {
    if (!wanted.has(verdict.program)) { unexpected.push(verdict.program); continue; }
    if (verdicts.has(verdict.program)) throw new Error(`duplicate final verdict: ${verdict.program}`);
    verdicts.set(verdict.program, verdict);
  }
  for (const event of eventRows) {
    const values = events.get(event.program) ?? [];
    values.push(event); events.set(event.program, values);
  }
  const rows = inventory.map(program => classifyProgram(program, verdicts.get(program), events.get(program)));
  const counts = {}, failures = {}, refusalGroups = new Map();
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (row.failureKind) failures[row.failureKind] = (failures[row.failureKind] ?? 0) + 1;
    for (const diagnostic of row.diagnostics) {
      const key = `${diagnostic.code}: ${diagnostic.message}`;
      const cases = refusalGroups.get(key) ?? new Set(); cases.add(row.program); refusalGroups.set(key, cases);
    }
  }
  return {
    schemaVersion: 1, generatedAt: new Date().toISOString(), metadata, inventoryCount: rows.length,
    complete: verdicts.size === rows.length && unexpected.length === 0, counts, failures, unexpected,
    passDetails: {
      nativeWithoutRuntimeFences: rows.filter(row => row.status === "passed-native" && row.runtimeFences.length === 0).length,
      nativeWithRuntimeFences: rows.filter(row => row.status === "passed-native" && row.runtimeFences.length > 0).length,
      withExternalFfi: rows.filter(row => row.status.startsWith("passed-") && row.externalFfi === true).length,
      flaky: rows.filter(row => row.status.startsWith("passed-") && row.flaky).length,
      exactStdoutStderrExit: rows.filter(row => row.status.startsWith("passed-") && row.comparison?.stdoutEqual && row.comparison.stderrEqual && row.comparison.rustExit === row.comparison.nodeExit).length,
      expectedNonzeroExit: rows.filter(row => row.status.startsWith("passed-") && row.comparison?.expectedExit !== undefined && row.comparison.expectedExit !== 0).length,
    },
    stderrPolicy: "Compared byte-for-byte for expected exit 0; expected nonzero cases check heap-audit silence, stdout and exit status under the existing harness policy.",
    diagnosticGroups: [...refusalGroups].map(([message, programs]) => ({ message, count: programs.size, programs: [...programs] })).sort((a,b) => b.count - a.count),
    rows,
  };
}

function jsonLines(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
  return lines.flatMap((line, index) => {
    try { return [JSON.parse(line)]; }
    catch (error) { if (index === lines.length - 1 && !readFileSync(file,"utf8").endsWith("\n")) return []; throw error; }
  });
}
export function readMatrix(directory) {
  const names = readdirSync(directory);
  return makeMatrix(
    JSON.parse(readFileSync(join(directory,"inventory.json"),"utf8")),
    names.filter(name => /^shard-\d+-cases\.jsonl$/.test(name)).flatMap(name => jsonLines(join(directory,name))),
    names.filter(name => /^shard-\d+-builds\.jsonl$/.test(name)).flatMap(name => jsonLines(join(directory,name))),
    JSON.parse(readFileSync(join(directory,"metadata.json"),"utf8")),
  );
}

export function writeMatrix(matrix, output) {
  mkdirSync(output,{recursive:true});
  writeFileSync(join(output,"rust-corpus-matrix.json"),JSON.stringify(matrix,null,2)+"\n");
  const columns=["program","status","failureKind","engine","externalFfi","target","durationMs","retried","flaky","skipReason","diagnostics"];
  const cell=value=>'"'+String(value??"").replaceAll('"','""')+'"';
  const csv=[columns,...matrix.rows.map(row=>columns.map(key=>key==="diagnostics"?row.diagnostics.map(d=>`${d.code}: ${d.message}`).join("; "):row[key]))];
  writeFileSync(join(output,"rust-corpus-matrix.csv"),csv.map(row=>row.map(cell).join(",")).join("\r\n")+"\r\n");
  const lines=["Matriz Rust do corpus ScriptC",`Atualizada: ${matrix.generatedAt}`,`Inventário: ${matrix.inventoryCount}; todos os veredictos presentes: ${matrix.complete}`,"",...Object.entries(matrix.counts).map(([key,value])=>`${key}: ${value}`),"","Detalhes dos passes:",...Object.entries(matrix.passDetails).map(([key,value])=>`${key}: ${value}`),"","Falhas observadas:",...Object.entries(matrix.failures).sort((a,b)=>b[1]-a[1]).map(([key,value])=>`${key}: ${value}`),"","Principais diagnósticos:",...matrix.diagnosticGroups.slice(0,20).flatMap(group=>[`${group.count}: ${group.message}`,`  Exemplos: ${group.programs.slice(0,5).join(", ")}`]),"","O denominador é este corpus, não todo JS/TS nem o ecossistema npm.","Compatibilidade observada nos caminhos exercitados pelos testes; runtimeFences registra funcionalidades recusadas quando executadas.","passed-native significa engine none na compilação que passou o teste; externalFfi é registrado separadamente.","Uma recusa ou um build bem-sucedido sem execução aprovada não conta como compatibilidade.",`Política de stderr: ${matrix.stderrPolicy}`,"",`Fontes, versões e hashes: metadata no JSON. Evidência bruta: ${matrix.metadata.evidenceDirectory??"diretório de execução"}`];
  writeFileSync(join(output,"rust-corpus-summary.txt"),lines.join("\n")+"\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory=process.argv[2],output=process.argv[3];
  if(!directory||!output) throw new Error("usage: node scripts/rust-corpus-matrix.mjs <run-directory> <output-directory>");
  const matrix=readMatrix(resolve(directory));
  matrix.metadata.evidenceDirectory=resolve(directory);
  matrix.metadata.runnerCompleted=existsSync(join(directory,"completed.json"));
  writeMatrix(matrix,resolve(output));
  console.log(JSON.stringify({inventory:matrix.inventoryCount,complete:matrix.complete,counts:matrix.counts,failures:matrix.failures}));
}
