// @rust-only
// @no-engine
const events = [];
const getRuntimeConfig = (configuration) => {
  events.push("factory");
  return { ...configuration, region: configuration?.region ?? "default" };
};
class Base {
  constructor(config) {
    events.push("base");
    this.config = config;
    this.baseConfig = config;
  }
  destroy() {}
}
class Client extends Base {
  config;
  constructor(...[configuration]) {
    const _config_0 = getRuntimeConfig(configuration || {});
    super(_config_0);
    events.push("derived");
    this.config = _config_0;
  }
}
const input = { region: "local", nested: { value: 7 } };
const client = new Client(input, events.push("extra"));
console.log(client.config.region);
console.log(client.config === client.baseConfig, client.config === input);
console.log(client.config.nested === input.nested);
client.config.nested.value = 9;
console.log(input.nested.value);
const fallback = new Client();
console.log(fallback.config.region);
const namedFactory = function build(config, label) { return { ...config, label }; };
class OtherClient extends Base {
  constructor(config, label) { super(namedFactory(config, label)); }
}
const other = new OtherClient(input, "named");
console.log(other.config.region, other.config.label);
console.log(events.join(","));
client.destroy();
