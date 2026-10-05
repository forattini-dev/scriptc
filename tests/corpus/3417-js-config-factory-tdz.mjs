// @rust-only
// @no-engine
class Base { constructor(config) { this.config = config; } }
class Client extends Base {
  constructor(config) { super(factory(config)); }
}
try { new Client({ region: "early" }); }
catch (error) { console.log(error.name, error.message); }
const factory = config => ({ ...config });
console.log(new Client({ region: "late" }).config.region);
