class Agent {
  /** @returns {boolean | undefined} */
  dispatch(lazy) {
    if (lazy) return this.asyncDispatch();
    return true;
  }

  async asyncDispatch() {
    await Promise.resolve();
    return 'loaded';
  }
}

async function main() {
  const agent = new Agent();
  const pending = agent.dispatch(true);
  console.log(await pending, agent.dispatch(false));
}

void main();
