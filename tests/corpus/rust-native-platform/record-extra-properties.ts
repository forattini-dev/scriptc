// @rust-only
// @no-engine
// @ts-nocheck
function make() { return { value: 'initial' }; }
const context = make();
const alias = context;
console.log('missing', context.displayName === undefined);
context.displayName = 'FocusContext';
console.log('added', context === alias, alias.displayName as string, Object.keys(context).join(','));
const copy: any = { ...context };
console.log('copy', copy.displayName as string, copy.value as string);
alias.displayName = 'changed';
console.log('changed', context.displayName as string);
context.self = context;
console.log('cycle', context.self === context);
delete context.self;
delete context.displayName;
console.log('deleted', alias.displayName === undefined, Object.keys(context).join(','));
