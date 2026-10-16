function parse(value) { return value; }
function endpointWithDefaults(defaults, route, options) { return parse(route); }
function withDefaults(oldDefaults, newDefaults) {
  const DEFAULTS2 = newDefaults;
  const endpoint2 = endpointWithDefaults.bind(null, DEFAULTS2);
  return Object.assign(endpoint2, {
    DEFAULTS: DEFAULTS2,
    defaults: withDefaults.bind(null, DEFAULTS2),
    merge: endpointWithDefaults.bind(null, DEFAULTS2),
    parse
  });
}
const defaults = { method: "GET" };
export var endpoint = withDefaults(null, defaults);
