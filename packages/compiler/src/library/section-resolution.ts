import { libAsyncExportDiag, libExportUnresolvedDiag, libGenericExportDiag, libSidecarDiag, libUnmappableSignatureDiag, LIB_INBOUND_BYTES_TRAP_CODE, LIB_RUNTIME_TRAP_CODES, type ScrDiagnostic } from "../diagnostics/diagnostic.js";
import { classSeed, numberCarrierKind, type FnIntSlots, type IntSlotConfig } from "./int-infer.js";
import { profileRemediation, profileTeaching, type LibraryProfile } from "./library-profile.js";
import { assembleTrapTeaching } from "./trap-teaching.js";
import { type SidecarIntegerSlotFacts, type SidecarIrRecordPattern, type SidecarIrTypePattern } from "./sidecar.js";
import { type EntryExportInfo } from "../frontend/lib-exports.js";
import { type IrLibSection, type IrModule, type IrRecordShape, type IrType } from "../ir/ir.js";

/** The marshalling-class fit over IR types (design §4.2 + the ratified
 * integer plumbing classes): number is every f64-backed class, bool/string
 * map directly, bytes is the u8 element kind. */
export function libClassFits(cls: string, t: IrType): boolean {
  switch (cls) {
    case "bool":
      return t.kind === "bool";
    case "string":
      return t.kind === "string";
    case "bytes":
      return t.kind === "bytes" && t.elem === "u8";
    default: // f64 and the u8/u32/i32 plumbing classes
      return t.kind === "f64";
  }
}

/** Resolve the profile's export map against the entry module — SC4002/
 * SC4004/SC4007 from the declaration facts, SC4003 from the lowered IR
 * signatures — and land the library section on the module. */
export function resolveLibrarySection(
  profile: LibraryProfile,
  entryInfo: Map<string, EntryExportInfo>,
  mod: IrModule,
  entryPath: string,
): { lib: IrLibSection } | { diagnostics: ScrDiagnostic[] } {
  const diagnostics: ScrDiagnostic[] = [];
  const entryLoc = { file: entryPath, start: 0, end: 0 };
  const fnByName = new Map(mod.functions.map((f) => [f.name, f]));
  const exports: IrLibSection["exports"] = [];
  for (const e of profile.exports) {
    const info = entryInfo.get(e.export);
    if (info === undefined) {
      diagnostics.push(
        libExportUnresolvedDiag(e.export, "the entry module has no exported function declaration by that name", entryLoc),
      );
      continue;
    }
    if (info.generic) {
      diagnostics.push(libGenericExportDiag(e.export, info.loc));
      continue;
    }
    if (info.async || info.generator) {
      diagnostics.push(libAsyncExportDiag(e.export, info.async ? "async" : "generator", info.loc));
      continue;
    }
    const fn = fnByName.get(e.export);
    if (fn === undefined) {
      diagnostics.push(
        libExportUnresolvedDiag(e.export, "the export did not lower to a compiled function", info.loc),
      );
      continue;
    }
    if (fn.params.length !== e.params.length) {
      diagnostics.push(
        libUnmappableSignatureDiag(
          e.export,
          "signature",
          `has ${fn.params.length} parameter(s) but the profile declares ${e.params.length} marshalling class(es)`,
          info.loc,
        ),
      );
      continue;
    }
    let bad = false;
    e.params.forEach((cls, i) => {
      if (!libClassFits(cls, fn.params[i]!.type)) {
        bad = true;
        diagnostics.push(
          libUnmappableSignatureDiag(
            e.export,
            `parameter ${i + 1} ('${fn.params[i]!.name}')`,
            `has IR type '${fn.params[i]!.type.kind}', which does not fit the declared marshalling class '${cls}'`,
            info.loc,
          ),
        );
      }
    });
    if (e.returns === "void" ? fn.returnType.kind !== "void" : !libClassFits(e.returns, fn.returnType)) {
      bad = true;
      diagnostics.push(
        libUnmappableSignatureDiag(
          e.export,
          "the return",
          `has IR type '${fn.returnType.kind}', which does not fit the declared marshalling class '${e.returns}'`,
          info.loc,
        ),
      );
    }
    if (!bad) {
      const resolvedExport: IrLibSection["exports"][number] = {
        symbol: e.symbol,
        fnName: e.export,
        params: e.params,
        returns: e.returns,
      };
      if (e.params.includes("bytes")) {
        // The wrapper's one host-contract trap (an inbound bytes length
        // past the marshalling class's range) is assembled HERE, once, as
        // the structured trap-teaching message: the profile's teaching for
        // SC4012 (or the mode's default text), the code, the trapping
        // export's C symbol exactly as the host linked it, and the
        // profile's remediation when supplied — so both backends emit the
        // same bytes and the sink sees one canonical message.
        resolvedExport.inboundBytesTrap = assembleTrapTeaching(
          profileTeaching(profile, LIB_INBOUND_BYTES_TRAP_CODE) ??
            "scriptc: library inbound bytes length out of range\n",
          LIB_INBOUND_BYTES_TRAP_CODE,
          e.symbol,
          profileRemediation(profile, LIB_INBOUND_BYTES_TRAP_CODE),
        );
      }
      if (e.params.includes("i64") || e.params.includes("u64")) {
        // The sibling host-contract trap for inbound declared-integer
        // parameters (ask 4): a value past ±(2^53−1) cannot ride f64
        // exactly, and silent rounding is a coercion the author never
        // wrote. Same code (SC4012 — one host-contract story), same
        // assembly-once discipline.
        resolvedExport.inboundIntTrap = assembleTrapTeaching(
          profileTeaching(profile, LIB_INBOUND_BYTES_TRAP_CODE) ??
            "scriptc: library inbound integer parameter out of range\n",
          LIB_INBOUND_BYTES_TRAP_CODE,
          e.symbol,
          profileRemediation(profile, LIB_INBOUND_BYTES_TRAP_CODE),
        );
      }
      exports.push(resolvedExport);
    }
  }
  if (diagnostics.length > 0) return { diagnostics };
  // The runtime detected-trap overlay rows: one per family code the profile
  // declares teaching or remediation text for, in the registry family's
  // order. Both backends emit exactly these rows as the program TU's
  // overlay table, so the funnel-assembled sink message is
  // emission-invariant by construction. (SC4012 stays compile-time
  // assembled into the wrapper's message above and never reaches the
  // funnel's assembly path.)
  const trapOverlays: IrLibSection["trapOverlays"] = [];
  for (const code of LIB_RUNTIME_TRAP_CODES) {
    const teaching = profileTeaching(profile, code);
    const remediation = profileRemediation(profile, code);
    if (teaching !== undefined || remediation !== undefined) {
      trapOverlays.push({
        code,
        ...(teaching !== undefined ? { teaching } : {}),
        ...(remediation !== undefined ? { remediation } : {}),
      });
    }
  }
  return {
    lib: {
      profileName: profile.name,
      prefix: profile.prefix,
      initSymbol: profile.initSymbol,
      sinkRegisterSymbol: profile.sinkRegisterSymbol,
      collectSymbol: profile.collectSymbol,
      resultResetSymbol: profile.resultResetSymbol,
      threadInstances: profile.instancePerThread,
      // Host-callback channels: declaration order is the runtime slot
      // assignment, and the unregistered-call trap text is assembled HERE,
      // once, so both backends emit identical constant bytes (a DETECTED
      // trap: the funnel classifies the "scriptc: library callback "
      // prefix as SC4025 and names the entry the host called — the entry
      // is runtime knowledge, so no compile-time SC4012-style assembly
      // can carry it). Both fields stay absent on callback-free profiles
      // (the byte-identity guarantee).
      ...(profile.callbacks.length > 0
        ? {
            callbackRegisterSymbol: profile.callbackRegisterSymbol!,
            callbacks: profile.callbacks.map((cb, i) => ({
              name: cb.name,
              slot: i,
              params: [...cb.params],
              returns: cb.returns,
              unregisteredTrap: `scriptc: library callback '${cb.name}' invoked before registration\n`,
            })),
          }
        : {}),
      exports,
      trapOverlays,
    },
  };
}

/** The export map's integer-slot obligations (ask 4): i64/u64 params and
 * returns become declared boundary slots keyed `exports.<name>.params[i]`
 * / `exports.<name>.return`; the u8/u32/i32 plumbing classes contribute
 * their proven inbound shapes as parameter seeds (the wrapper's coercion
 * contract), tightening the intraprocedural analysis at zero declaration
 * cost. Sidecar-declared slots (record fields, msg arms, helper params
 * and returns) merge into the same config at sidecar build. */
export function libraryIntSlotConfig(profile: LibraryProfile): IntSlotConfig {
  const cfg: IntSlotConfig = { fns: new Map(), records: new Map() };
  for (const e of profile.exports) {
    const params = e.params.map((c) => (c === "i64" || c === "u64" ? c : null));
    const ret = e.returns === "i64" || e.returns === "u64" ? e.returns : null;
    const paramSeeds = e.params.map((c) => (c === "u8" || c === "u32" || c === "i32" ? classSeed(c) : null));
    if (params.every((p) => p === null) && ret === null && paramSeeds.every((s) => s === null)) continue;
    const slots: FnIntSlots = {
      fnName: e.export,
      params,
      paramPaths: e.params.map((c, i) => (c === "i64" || c === "u64" ? `exports.${e.export}.params[${i}]` : null)),
      ret,
      retPath: ret !== null ? `exports.${e.export}.return` : null,
      paramSeeds,
    };
    cfg.fns.set(e.export, slots);
  }
  return cfg;
}

/** Match the sidecar syntax's exact structural type projection against the
 * frontend's interned IR registries. The pattern deliberately mirrors
 * ShapeRegistry's identity: every field name and recursively mapped field
 * type participates. Tagged payload records additionally accept omission
 * of their `kind` field because the lowering may carry that discriminant
 * only in the surrounding union tag. */
export function sidecarRecordMatcher(
  mod: IrModule,
): (pattern: SidecarIrRecordPattern, shape: IrRecordShape) => boolean {
  const records = new Map((mod.records ?? []).map((shape) => [shape.id, shape]));
  const unions = new Map((mod.unions ?? []).map((union) => [union.id, union]));

  const recordMatches = (
    pattern: SidecarIrRecordPattern,
    shape: IrRecordShape,
  ): boolean => {
    if (shape.tuple === true || shape.indexValue !== undefined) return false;
    const variants = [pattern.fields];
    if (pattern.kindMayBeOmitted === true) {
      variants.push(pattern.fields.filter((field) => field.name !== "kind"));
    }
    return variants.some(
      (fields) =>
        fields.length === shape.fields.length &&
        fields.every((field) => {
          const actual = shape.fields.find((candidate) => candidate.name === field.name);
          return actual !== undefined && typeMatches(field.type, actual.type);
        }),
    );
  };

  const unionMatches = (
    patterns: SidecarIrTypePattern[],
    actual: IrType[],
  ): boolean => {
    if (patterns.length !== actual.length) return false;
    const used = new Set<number>();
    const visit = (index: number): boolean => {
      if (index === patterns.length) return true;
      for (let i = 0; i < actual.length; i++) {
        if (used.has(i) || !typeMatches(patterns[index]!, actual[i]!)) continue;
        used.add(i);
        if (visit(index + 1)) return true;
        used.delete(i);
      }
      return false;
    };
    return visit(0);
  };

  const typeMatches = (
    pattern: SidecarIrTypePattern,
    actual: IrType,
  ): boolean => {
    switch (pattern.kind) {
      case "f64":
      case "string":
      case "bool":
      case "nullT":
      case "undefinedT":
      case "dyn":
        return actual.kind === pattern.kind;
      case "bytes":
        return actual.kind === "bytes" && actual.elem === pattern.elem;
      case "array":
        return actual.kind === "array" && typeMatches(pattern.elem, actual.elem);
      case "record": {
        if (actual.kind !== "record") return false;
        const shape = records.get(actual.shapeId);
        return shape !== undefined && recordMatches(pattern, shape);
      }
      case "union": {
        if (actual.kind !== "union") return false;
        const union = unions.get(actual.unionId);
        return union !== undefined && unionMatches(pattern.arms, union.arms);
      }
    }
  };

  return (pattern, shape) => recordMatches(pattern, shape);
}

/** Merge the sidecar-resolved integer slots (ask 4) into the inference
 * config: helper slots key by function name and IR parameter index (the
 * projection already shifted past the model receiver); record-field
 * slots map onto every interned IR shape whose complete structural field
 * signature matches the projected record's. Shapes intern structurally,
 * so a same-shaped second type shares the obligation. DECLARED paths with
 * the same class coalesce while retaining every source path for verdicts;
 * differing classes refuse because one lowered field cannot seed or check
 * two distinct class contracts without arm provenance. A
 * record fact that matches no shape binds nothing: no compiled code
 * constructs the type (the contract surface — init/update/subscriptions
 * and every helper — is force-lowered whenever integer slots are
 * declared, so this is genuine vacuity, not dead-stripping). */
export function mergeSidecarIntSlots(
  cfg: IntSlotConfig,
  facts: SidecarIntegerSlotFacts,
  mod: IrModule,
): { ok: true; config: IntSlotConfig } | { ok: false; diagnostic: ScrDiagnostic } {
  const recordMatches = sidecarRecordMatcher(mod);
  for (const h of facts.helpers) {
    const fn = mod.functions.find((f) => f.name === h.fnName);
    const arity = Math.max(fn?.params.length ?? 0, (h.index ?? 0) + 1);
    let slots = cfg.fns.get(h.fnName);
    if (slots === undefined) {
      slots = {
        fnName: h.fnName,
        params: new Array<null>(arity).fill(null),
        paramPaths: new Array<null>(arity).fill(null),
        ret: null,
        retPath: null,
        paramSeeds: new Array<null>(arity).fill(null),
      };
      cfg.fns.set(h.fnName, slots);
    }
    if (h.kind === "param") {
      const i = h.index!;
      while (slots.params.length <= i) {
        slots.params.push(null);
        slots.paramPaths.push(null);
        slots.paramSeeds.push(null);
      }
      slots.params[i] = h.cls;
      slots.paramPaths[i] = h.path;
    } else {
      slots.ret = h.cls;
      slots.retPath = h.path;
    }
  }
  for (const r of facts.records) {
    for (const shape of mod.records ?? []) {
      if (!recordMatches(r.shape, shape)) continue;
      const target = shape.fields.find((f) => f.name === r.targetField);
      if (target === undefined || numberCarrierKind(target.type, mod) === null) continue;
      let m = cfg.records.get(shape.id);
      if (m === undefined) {
        m = new Map();
        cfg.records.set(shape.id, m);
      }
      const existing = m.get(r.targetField);
      if (existing !== undefined && existing.cls !== r.cls) {
        const paths = [
          ...existing.paths.map((path) => `'${path}' (${existing.cls})`),
          `'${r.path}' (${r.cls})`,
        ];
        return {
          ok: false,
          diagnostic: libSidecarDiag(
            `integer slots ${paths.join(" and ")} collapse to the same lowered record field '${r.targetField}' — their proof obligations cannot be kept distinct`,
            r.loc,
            "kind-tagged union arms and structurally identical records may share one lowered shape — same-class declarations coalesce, but differing classes require distinct structural shapes or at most one classified slot",
          ),
        };
      }
      if (existing === undefined) {
        m.set(r.targetField, { cls: r.cls, paths: [r.path] });
      } else if (!existing.paths.includes(r.path)) {
        existing.paths.push(r.path);
      }
    }
  }
  return { ok: true, config: cfg };
}
