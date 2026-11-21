export type LiteralType =
  | { type: "string" | "number" | "integer" | "boolean"; const: string | number | boolean }
  | { type: "object" | "array" };
export declare function parseLiteralDef(value: unknown, target: string): LiteralType;
