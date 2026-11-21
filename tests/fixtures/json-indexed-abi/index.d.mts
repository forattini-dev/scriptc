export type JsonValue = string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export declare function serialize(value: JsonValue, options?: { flag?: boolean }): string;
export declare const encode: typeof serialize;
