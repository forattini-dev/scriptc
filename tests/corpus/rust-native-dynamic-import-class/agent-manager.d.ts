export interface AgentOptions { connections: number }
export declare class AgentManager {
  readonly options: AgentOptions;
  readonly cache: Map<string, string>;
  constructor(options: AgentOptions, cache: Map<string, string>);
  describe(): string;
}
