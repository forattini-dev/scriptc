// @rust-only
// @no-engine
// @ts-nocheck
class Fault extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fault";
  }
}
const Alias = Fault;
const fault = new Alias("alias");
console.log("alias", fault.name, fault.message, fault instanceof Fault, Alias === Fault);
const Constructor = class extends Error {};
const expression = new Constructor("expression");
console.log("expression", expression.message, expression instanceof Error);
var Hoisted = class extends Error {};
const hoisted = new Hoisted("hoisted");
console.log("hoisted", hoisted.message, hoisted instanceof Error);

class PluginBase {
  static plugins: Array<(value: number) => number> = [];
  static plugin(...newPlugins: Array<(value: number) => number>) {
    const currentPlugins = this.plugins;
    const Extended = class extends this {
      static plugins = currentPlugins.concat(
        newPlugins.filter((plugin) => !currentPlugins.includes(plugin)),
      );
    };
    return Extended;
  }
}
const PluginClass = PluginBase.plugin((value) => value + 1);
console.log("factory", PluginClass.plugins.length, PluginClass.plugins[0](41));
