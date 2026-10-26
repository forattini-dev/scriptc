export function used(value: unknown): boolean;
export function acceptsError(value: Error): boolean;
export function unused(): {
  error?: Error;
  nested: {error: TypeError}[];
  read: (error: RangeError) => boolean;
};
