class Pool {
  intercept() {
    return "intercepted";
  }
}

class Agent {
  get() {
    return new Pool();
  }

  dispatch() {
    this.get();
  }

  setup() {
    const pool = this.get();
    return pool.intercept();
  }
}

const agent = new Agent();
agent.dispatch();
console.log(agent.setup());
