import type { AgentManager as AgentManagerType } from "./agent-manager.js";

class Client {
  private agentManager?: AgentManagerType;

  async transport(): Promise<string> {
    if (!this.agentManager) {
      const protocolCache = new Map([["example.test", "h2"]]);
      const { AgentManager } = await import("./agent-manager.js");
      this.agentManager = new AgentManager({ connections: 4 }, protocolCache);
    }
    return this.agentManager.describe();
  }
}

async function main(): Promise<void> {
  const client = new Client();
  console.log(await client.transport());
  console.log(await client.transport());
}

main();
