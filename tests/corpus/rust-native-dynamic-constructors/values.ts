// @rust-only
// @no-engine
class First { value: number; constructor(value: number) { this.value = value; } }
class Second { value: number; constructor(value: number, extra = 1) { this.value = value + extra; } }
class Failure { constructor(value: number) { throw new Error('failure'); } }
class NoArgs { value = 12; }
function create(kind: any, value: number): any { return new kind(value); }
function createZero(kind: any): any { return new kind(); }
function createTwo(kind: any, value: number, extra: number): any { return new kind(value, extra); }
const one: any = create(First, 4);
const two: any = create(Second, 4);
console.log('dispatch', one instanceof First, two instanceof Second, one.value === 4, two.value === 5);
console.log('arity', createZero(NoArgs).value === 12, createTwo(First, 2, 8).value === 2,
  createTwo(Second, 2, 8).value === 10);
const options: { Group: any } = { Group: First };
function fromOptions(value: number): any { return new options.Group(value); }
console.log('property-a', fromOptions(8).value === 8);
options.Group = Second;
console.log('property-b', fromOptions(8).value === 9);
let trace = '';
function change(): number { trace += 'a'; options.Group = First; return 10; }
console.log('snapshot', new options.Group(change()).value === 11, trace);
try { create(0, 3); } catch (error) { console.log('non-constructor', error instanceof TypeError, (error as Error).message); }
try { create(Failure, 3); } catch (error) { console.log('throw', error instanceof Error, (error as Error).message); }
let registered: any;
function register(value: any): number { registered = value; return 0; }
class Registered { static registration = register(this); value = 7; }
function createRegistered(): any { return new registered(); }
console.log('registered', createRegistered().value === 7);
