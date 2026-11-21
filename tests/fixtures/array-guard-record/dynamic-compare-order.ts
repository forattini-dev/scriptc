const log: string[] = [];
const left: any = {
  label: 'left',
  get valueOf() {
    log.push('get-left');
    return function(this: any) { log.push('call-' + this.label); return 2; };
  },
};
const right: any = {
  label: 'right',
  get valueOf() {
    log.push('get-right');
    return function(this: any) { log.push('call-' + this.label); return 3; };
  },
};
function first() { log.push('eval-left'); return left; }
function second() { log.push('eval-right'); return right; }
for (let mode = 0; mode < 4; mode++) {
  log.length = 0;
  let result: boolean;
  if (mode === 0) result = first() < second();
  else if (mode === 1) result = first() <= second();
  else if (mode === 2) result = first() > second();
  else result = first() >= second();
  console.log(mode, result, log.join(','));
}
const bad: any = { [Symbol.toPrimitive]: 4 };
try { console.log(bad < 1); } catch (error) { console.log('noncallable', error instanceof TypeError); }
const invalid: any = { [Symbol.toPrimitive]() { return {}; } };
try { console.log(invalid < 1); } catch (error) { console.log('nonprimitive', error instanceof TypeError); }
const absent: any = { [Symbol.toPrimitive]: null, valueOf() { return 2; } };
console.log('null-hook', absent < 3);
const throwing: any = { valueOf() { log.push('throw-left'); throw new Error('failure'); } };
function throwingFirst() { log.push('eval-throwing'); return throwing; }
log.length = 0;
try { console.log(throwingFirst() < second()); }
catch (error) { console.log('throwing', error instanceof Error, log.join(',')); }
