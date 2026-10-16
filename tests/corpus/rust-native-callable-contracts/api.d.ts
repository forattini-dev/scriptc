export interface Endpoint {
  (value: number): number;
  offset: number;
  parse: (value: number) => number;
}
export declare const endpoint: Endpoint;
