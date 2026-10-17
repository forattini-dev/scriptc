export interface Auth<Result> {
  (...args: []): Promise<Result>;
  hook: {
    <T>(request: (value: T) => T, value: T): T;
    <T>(request: (value: T) => T, value: T, extra: unknown): T;
  };
}
export interface Strategy<Options extends unknown[], Result> {
  (...args: Options): Auth<Result>;
}
export declare const createTokenAuth: Strategy<[token: string], { token: string }>;
export declare const pair: (...args: [first: number, second?: string]) => string;
export declare const empty: (...args: []) => number;
