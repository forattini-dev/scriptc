export class AgentManager {
  constructor(options, cache) {
    this.options = options;
    this.cache = cache;
  }
  describe() {
    return `agents=${this.options.connections} cached=${this.cache.size}`;
  }
}
