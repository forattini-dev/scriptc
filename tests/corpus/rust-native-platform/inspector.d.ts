declare module "node:inspector" {
  export class Session {
    connect(): void;
    disconnect(): void;
    post(method: "Profiler.enable" | "Profiler.start", callback: (error: Error | null) => void): void;
    post(method: "Profiler.stop", callback: (error: Error | null, result: { profile: { nodes: unknown[] } }) => void): void;
  }
}
