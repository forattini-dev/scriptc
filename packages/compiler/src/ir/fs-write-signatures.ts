import { BOOL, BYTES_U8, F64, STRING, VOID, type IrLibFn, type IrType } from "./ir.js";

/** Whole-file writes, including creation-only modes and exclusive append. */
export const FS_WRITE_LIB_SIGS = {
  "fs.writeFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.appendFileSync": { argTypes: [STRING, STRING], result: VOID },
  "fs.writeFileModeSync": { argTypes: [STRING, STRING, F64], result: VOID },
  "fs.writeFileExclusiveModeSync": { argTypes: [STRING, STRING, F64], result: VOID },
  "fs.writeFileSyncBytes": { argTypes: [STRING, BYTES_U8], result: VOID },
  "fsp.writeFile": { argTypes: [STRING, STRING], result: { kind: "promise", inner: VOID } },
  "fsp.writeFileMode": { argTypes: [STRING, STRING, F64], result: { kind: "promise", inner: VOID } },
  "fsp.writeFileExclusiveMode": { argTypes: [STRING, STRING, F64], result: { kind: "promise", inner: VOID } },
  "fs.appendFileModeSync": { argTypes: [STRING, STRING, F64, BOOL], result: VOID },
} satisfies Partial<Record<IrLibFn, { argTypes: IrType[]; result: IrType }>>;
