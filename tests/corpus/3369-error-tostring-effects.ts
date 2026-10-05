let constructions = 0;
class StatefulError extends Error {
  calls = 0;
  override toString(): string {
    this.calls++;
    if (this.calls === 3 || this.calls === 5) throw new Error(`render failed ${this.calls}`);
    return `render ${this.calls}`;
  }
}
function make(): Error { constructions++; return new StatefulError("ignored"); }
console.log(String(make()), constructions);
const error = new StatefulError("ignored");
const base: Error = error;
console.log(base.toString());
const erased: unknown = error;
console.log(String(erased));
try { console.log(`${erased}`); } catch (caught) { console.log(String(caught)); }
try { throw error; } catch (caught) { console.log(String(caught)); }
try { console.log(String(erased)); } catch (caught) { console.log(String(caught)); }
console.log(error.calls);
