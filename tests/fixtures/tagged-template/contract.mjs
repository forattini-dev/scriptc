const events = [];
const sites = [];
const receiver = {
  tag(strings, ...values) {
    events.push(`call:${this === receiver}`);
    sites.push(strings);
    console.log('content', strings[0], strings.raw[0], values.join(','));
    console.log('frozen', Object.isFrozen(strings), Object.isFrozen(strings.raw));
    const raw = Object.getOwnPropertyDescriptor(strings, 'raw');
    console.log('descriptor', raw.writable, raw.enumerable, raw.configurable);
    try { strings[0] = 'changed'; } catch (error) { console.log('write', error.name); }
    return strings;
  },
};
function substitute() { events.push('substitute'); return 7; }
function run() { return receiver.tag`line\n${substitute()}`; }
const first = run();
const second = run();
const other = receiver.tag`line\n${7}`;
console.log('identity', first === second, first === other, sites[0].raw === sites[1].raw);
console.log('order', events.join(','));
function invalid(strings) { console.log('invalid', strings[0], strings.raw[0]); }
invalid`\unicode`;
