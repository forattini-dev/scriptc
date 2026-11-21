export type Meta = { description?: string; title?: string; default?: any };
export type RefType = { $ref: string } & Meta;
export type LooseRefType = { $ref?: string } & Meta;
export type StringType = { type: "string"; minLength?: number } & Meta;
export type AnyOfType = { anyOf: SchemaType[] } & Meta;
export type SchemaType = LooseRefType | StringType | AnyOfType | RefType;
export declare function parseDef(kind: string, seen: Map<string, string>): SchemaType | undefined;
