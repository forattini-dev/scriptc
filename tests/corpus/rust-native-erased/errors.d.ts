export declare class ParseError extends Error {
  code: string;
  details?: Record<string, unknown> | undefined;
  constructor(message: string, code: string, details?: Record<string, unknown> | undefined);
}
export declare class InvalidError extends ParseError {
  value: string;
  constructor(value: string);
}
