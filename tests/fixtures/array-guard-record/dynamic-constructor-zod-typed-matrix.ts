type Def = { x: number; label?: string };
const trace: string[] = [];
class Base { _def: Def; kind: string; constructor(def: Def) { trace.push('base'); this._def = def; this.kind = 'base'; } describe(label: string): any { const This: any = this.constructor; return new This({ ...this._def, label }); } }
class Child extends Base { constructor(def: Def) { super(def); trace.push('child'); this.kind = 'child'; } }
class Grandchild extends Child { constructor(def: Def) { super(def); trace.push('grandchild'); this.kind = 'grandchild'; } }
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 4; action++) {
  trace.length = 0;
  let input: Base;
  if (mode % 3 === 0) input = new Base({ x: 1 });
  else if (mode % 3 === 1) input = new Child({ x: 1 });
  else input = new Grandchild({ x: 1 });
  try {
    if (mode === 3) (input as any).constructor = Child;
    if (mode === 4) (input as any).constructor = 7;
    if (mode === 5) Object.defineProperty(input, 'constructor', { get() { trace.push('get'); return Child; } });
    if (mode === 6) (Base.prototype as any).constructor = Child;
    const out: any = input.describe('new');
    let result: string;
    if (action === 0) result = 'kind:' + out.kind;
    else if (action === 1) result = 'instance:' + (out instanceof Base) + ':' + (out instanceof Child);
    else if (action === 2) result = 'fields:' + out._def.x + ':' + out._def.label;
    else result = 'identity:' + (out !== input) + ':' + (out._def !== input._def);
    console.log(mode, action, result, trace.join(','));
  } catch (e) { console.log(mode, action, e instanceof TypeError ? 'TypeError' : 'other', trace.join(',')); }
}
