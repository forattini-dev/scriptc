type Def = { x: number; label?: string };
const trace: string[] = [];
class Base { _def: Def; kind: string; constructor(def: Def) { trace.push('base'); this._def = def; this.kind = 'base'; } describe(label: string): any { const This: any = this.constructor; return new This({ ...this._def, label }); } }
class Child extends Base { constructor(def: Def) { super(def); trace.push('child'); this.kind = 'child'; } }
function Ordinary(this: any, def: Def): any { trace.push('ordinary'); this._def = def; this.kind = 'ordinary'; }
function Replacement(this: any, def: Def): any { trace.push('replacement'); return { _def: def, kind: 'replacement' }; }
function Primitive(this: any, def: Def): any { trace.push('primitive'); this._def = def; this.kind = 'primitive'; return 5; }
const arrow = (def: Def): any => ({ _def: def, kind: 'arrow' });
for (let mode = 0; mode < 8; mode++) for (let action = 0; action < 4; action++) {
  trace.length = 0;
  const input = new Base({ x: 1 });
  const constructor: any = mode === 0 ? Ordinary : mode === 1 ? Replacement : mode === 2 ? Primitive : mode === 3 ? arrow : mode === 4 ? Ordinary.bind(null) : mode === 5 ? Child : mode === 6 ? null : undefined;
  (input as any).constructor = constructor;
  try {
    const out: any = input.describe('new');
    let result: string;
    if (action === 0) result = 'kind:' + out.kind;
    else if (action === 1) result = 'instance:' + (out instanceof Base) + ':' + (out instanceof Child);
    else if (action === 2) result = 'fields:' + out._def.x + ':' + out._def.label;
    else result = 'identity:' + (out !== input) + ':' + (out._def !== input._def);
    console.log(mode, action, result, trace.join(','));
  } catch (e) { console.log(mode, action, e instanceof TypeError ? 'TypeError' : 'other', trace.join(',')); }
}
