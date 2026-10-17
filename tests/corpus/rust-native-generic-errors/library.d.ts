export declare class ResponseError<T> extends Error {
  readonly request: { url: string; [key: string]: unknown };
  readonly response: { data: T; errors: { message: string }[] };
  readonly data: T;
  readonly errors: { message: string }[];
  constructor(request: { url: string; [key: string]: unknown }, response: { data: T; errors: { message: string }[] });
}
