const shared: any = { label: 'shared' };
const map = new Map<string, any>();
map.set('undefined', undefined);
map.set('null', null);
map.set('false', false);
map.set('nan', NaN);
map.set('zero', -0);
map.set('object', shared);
for (const value of map.values()) {
  console.log(typeof value, value === shared, JSON.stringify(value));
}
