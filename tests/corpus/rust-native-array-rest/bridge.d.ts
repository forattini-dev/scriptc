export function make(prefix: string): (...parts: string[]) => string;
export const gather: (...parts: string[]) => string[];
export function record(prefix: string, ...parts: string[]): { prefix: string; parts: string[] };
