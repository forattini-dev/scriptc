import { BIGINT, BOOL, F64, STRING } from "./type-constants.js";

export const BIGINT_LIB_FN_SIGS = {
  "bigint.fromString": { argTypes: [STRING], result: BIGINT },
  "bigint.fromNumber": { argTypes: [F64], result: BIGINT },
  "bigint.fromBool": { argTypes: [BOOL], result: BIGINT },
  "bigint.toString": { argTypes: [BIGINT], result: STRING },
  "bigint.toNumber": { argTypes: [BIGINT], result: F64 },
  "bigint.truthy": { argTypes: [BIGINT], result: BOOL },
  "bigint.radix": { argTypes: [BIGINT, F64], result: STRING },
  "bigint.add": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.sub": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.mul": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.div": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.rem": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.pow": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.and": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.or": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.xor": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.shl": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.shr": { argTypes: [BIGINT, BIGINT], result: BIGINT },
  "bigint.neg": { argTypes: [BIGINT], result: BIGINT },
  "bigint.not": { argTypes: [BIGINT], result: BIGINT },
  "bigint.cmp": { argTypes: [BIGINT, BIGINT], result: F64 },
  "bigint.cmpNumber": { argTypes: [BIGINT, F64], result: F64 },
  "bigint.asIntN": { argTypes: [F64, BIGINT], result: BIGINT },
  "bigint.asUintN": { argTypes: [F64, BIGINT], result: BIGINT },
};
export type IrBigIntLibFn = keyof typeof BIGINT_LIB_FN_SIGS;
export const BIGINT_MAY_THROW = Object.keys(BIGINT_LIB_FN_SIGS) as IrBigIntLibFn[];
