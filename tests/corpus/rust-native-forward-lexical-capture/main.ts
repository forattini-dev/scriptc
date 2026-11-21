interface Plugin { name: string }

function setup(names: string[]): string[] {
  const registerPlugin = (plugin: Plugin, priority = 0) => {
    pluginRegistrations.push(`${plugin.name}@${priority}`);
  };

  const pluginRegistrations: string[] = [];

  for (const name of names) {
    registerPlugin({ name }, name.length);
  }
  return pluginRegistrations;
}

console.log(setup(["retry", "cache"]).join(","));

class Client {
  readonly registered: string[];
  constructor(names: string[]) {
    const registerPlugin = (plugin: Plugin, manifest: { priority?: number } = {}) => {
      pluginRegistrations.push(`${plugin.name}:${manifest.priority ?? 0}`);
    };

    const pluginRegistrations: string[] = [];
    for (const name of names) {
      registerPlugin({ name }, { priority: name.length });
    }
    registerPlugin({ name: "default" });
    this.registered = pluginRegistrations;
  }
}

console.log(new Client(["auth", "retry"]).registered.join(","));
