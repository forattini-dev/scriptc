interface Endpoint<D extends object = object> {
  <T>(value: T): T;
  (route: string, options?: Record<string, unknown>): string;
  DEFAULTS: D;
  defaults: <O extends object>(options: O) => Endpoint<D & O>;
  merge: { <T>(value: T, options?: object): T; (): D };
  parse: <T>(value: T) => T;
}
export declare const endpoint: Endpoint<{ method: string }>;
