/* Focused LLVM expression emission extracted from emitter.ts. */
import { InternalCompilerError } from "../../errors.js";
import { F64, IrBytesElem, IrExpr } from "../../ir/ir.js";
import type { LlvmEmitterContext, LlValue } from "./expr-context.js";
import { F64_INF, f64Lit } from "./common.js";

const BYTES_NUM_KIND: Record<string, { kind: number; le: boolean } | undefined> = {
  u8: { kind: 0, le: false },
  i8: { kind: 1, le: false },
  u16be: { kind: 2, le: false },
  u16le: { kind: 2, le: true },
  i16be: { kind: 3, le: false },
  i16le: { kind: 3, le: true },
  u32be: { kind: 4, le: false },
  u32le: { kind: 4, le: true },
  i32be: { kind: 5, le: false },
  i32le: { kind: 5, le: true },
  f32be: { kind: 6, le: false },
  f32le: { kind: 6, le: true },
  f64be: { kind: 7, le: false },
  f64le: { kind: 7, le: true },
};

const BYTES_NUM_VAR: Record<string, { sign: boolean; le: boolean } | undefined> = {
  ube: { sign: false, le: false },
  ule: { sign: false, le: true },
  ibe: { sign: true, le: false },
  ile: { sign: true, le: true },
};

const DV_GET_KIND: Record<string, number> = {
  dvGetUint8: 0,
  dvGetInt8: 1,
  dvGetUint16: 2,
  dvGetInt16: 3,
  dvGetUint32: 4,
  dvGetInt32: 5,
  dvGetFloat32: 6,
  dvGetFloat64: 7,
  dvGetBigUint64Number: 8,
  dvGetBigInt64Number: 9,
};

const DV_SET_KIND: Record<string, number> = {
  dvSetUint8: 0,
  dvSetInt8: 1,
  dvSetUint16: 2,
  dvSetInt16: 3,
  dvSetUint32: 4,
  dvSetInt32: 5,
  dvSetFloat32: 6,
  dvSetFloat64: 7,
};

export function emitIntegerLoopIndex(host: LlvmEmitterContext, expr: IrExpr): string | null {
    if (expr.kind !== "varRef") return null;
    const slot = host.integerLoopBindings.get(expr.localId);
    if (slot === undefined) return null;
    const index = host.B.tmp();
    host.B.line(`${index} = load ${host.sizeType}, ptr ${slot}`);
    return index;
  }

export function emitBytesIndex(host: LlvmEmitterContext, receiver: string, index: string, integerIndex = false): string {
    const B = host.B;
    const lenPtr = B.tmp();
    const len = B.tmp();
    B.line(`${lenPtr} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
    B.line(`${len} = load ${host.sizeType}, ptr ${lenPtr}`);
    if (integerIndex) {
      const inRange = B.tmp();
      B.line(`${inRange} = icmp ult ${host.sizeType} ${index}, ${len}`);
      const invalid = B.newLabel("bytes.index.invalid");
      const valid = B.newLabel("bytes.index.valid");
      B.condBr(inRange, valid, invalid);
      B.startBlock(invalid);
      const indexF64 = B.tmp();
      B.line(`${indexF64} = uitofp ${host.sizeType} ${index} to double`);
      host.declare(`declare double @scr_bytes_get(ptr, double)`);
      B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${indexF64})`);
      B.terminate("unreachable");
      B.startBlock(valid);
      return index;
    }
    const lenF64 = B.tmp();
    const nonnegative = B.tmp();
    const belowLen = B.tmp();
    const inRange = B.tmp();
    B.line(`${lenF64} = uitofp ${host.sizeType} ${len} to double`);
    B.line(`${nonnegative} = fcmp oge double ${index}, ${f64Lit(0)}`);
    B.line(`${belowLen} = fcmp olt double ${index}, ${lenF64}`);
    B.line(`${inRange} = and i1 ${nonnegative}, ${belowLen}`);

    const rangeOk = B.newLabel("bytes.index.range");
    const invalid = B.newLabel("bytes.index.invalid");
    const valid = B.newLabel("bytes.index.valid");
    B.condBr(inRange, rangeOk, invalid);

    B.startBlock(rangeOk);
    const idx = B.tmp();
    const roundTrip = B.tmp();
    const integral = B.tmp();
    B.line(`${idx} = fptoui double ${index} to ${host.sizeType}`);
    B.line(`${roundTrip} = uitofp ${host.sizeType} ${idx} to double`);
    B.line(`${integral} = fcmp oeq double ${roundTrip}, ${index}`);
    B.condBr(integral, valid, invalid);

    B.startBlock(invalid);
    host.declare(`declare double @scr_bytes_get(ptr, double)`);
    B.line(`call double @scr_bytes_get(ptr ${receiver}, double ${index})`);
    B.terminate("unreachable");

    B.startBlock(valid);
    return idx;
  }

export function emitBytesData(host: LlvmEmitterContext, receiver: string): string {
    const p = host.B.tmp();
    const data = host.B.tmp();
    host.B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 3`);
    host.B.line(`${data} = load ptr, ptr ${p}`);
    return data;
  }

export function emitBytesLength(host: LlvmEmitterContext, elem: IrBytesElem, receiver: string, bytes: boolean): LlValue {
    const B = host.B;
    const p = B.tmp();
    const len = B.tmp();
    B.line(`${p} = getelementptr inbounds %ScrBytes, ptr ${receiver}, i64 0, i32 1`);
    B.line(`${len} = load ${host.sizeType}, ptr ${p}`);
    const count = bytes && elem !== "u8" ? B.tmp() : len;
    if (count !== len) B.line(`${count} = shl ${host.sizeType} ${len}, ${elem === "f64" ? 3 : 2}`);
    const out = B.tmp();
    B.line(`${out} = uitofp ${host.sizeType} ${count} to double`);
    return { name: out, type: F64 };
  }

export function emitBytesGet(host: LlvmEmitterContext, elem: IrBytesElem, receiver: string, index: string, integerIndex = false): LlValue {
    const B = host.B;
    const idx = host.emitBytesIndex(receiver, index, integerIndex);
    const data = host.emitBytesData(receiver);
    const p = B.tmp();
    if (elem === "u8") {
      const raw = B.tmp();
      const wide = B.tmp();
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds i8, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`${raw} = load i8, ptr ${p}, align 1`);
      B.line(`${wide} = zext i8 ${raw} to i32`);
      B.line(`${out} = uitofp i32 ${wide} to double`);
      return { name: out, type: F64 };
    }
    if (elem === "f32" || elem === "f64") {
      const raw = B.tmp();
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds ${elem === "f64" ? "double" : "float"}, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`${raw} = load ${elem === "f64" ? "double" : "float"}, ptr ${p}, align 1`);
      if (elem === "f32") B.line(`${out} = fpext float ${raw} to double`);
      return { name: elem === "f64" ? raw : out, type: F64 };
    }
    if (elem === "f64") {
      const out = B.tmp();
      B.line(`${p} = getelementptr inbounds double, ptr ${data}, ${host.sizeType} ${idx}`);
      B.line(`${out} = load double, ptr ${p}, align 1`);
      return { name: out, type: F64 };
    }
    const raw = B.tmp();
    const out = B.tmp();
    B.line(`${p} = getelementptr inbounds i32, ptr ${data}, ${host.sizeType} ${idx}`);
    B.line(`${raw} = load i32, ptr ${p}, align 1`);
    B.line(`${out} = ${elem === "i32" ? "sitofp" : "uitofp"} i32 ${raw} to double`);
    return { name: out, type: F64 };
  }

    const stored = elem === "f32" || elem === "f64" ? null : host.emitToUint32(value);
