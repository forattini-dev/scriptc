const log: string[] = [];
const object: any = {
  tag: 'item',
  get toString() {
    log.push(`get:${this.tag}`);
    return function (this: any) {
      log.push(`call:${this.tag}`);
      return this.tag;
    };
  },
};
const array: any[] = [object];
console.log((array as string[]).join('|'), log.join(','));
