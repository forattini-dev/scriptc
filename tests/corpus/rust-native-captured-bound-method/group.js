export const Group = (function () {
  const Scripts = { allKeys: (id) => [`b_${id}_settings`, `b_${id}_running`] };
  class Group {
    constructor(id) {
      this.id = id;
      this.instances = {};
      this.deleteKey = this.deleteKey.bind(this);
    }
    key(key = "") {
      const existing = this.instances[key];
      if (existing != null) return existing;
      const created = { name: `${this.id}-${key}`, disconnect: async () => { console.log("disconnect", key); } };
      this.instances[key] = created;
      return created;
    }
    async deleteKey(key = "") {
      const keys = Scripts.allKeys(`${this.id}-${key}`);
      const instance = this.instances[key];
      if (instance != null) {
        delete this.instances[key];
        await instance.disconnect();
      }
      return instance != null || keys.length === 0;
    }
  }
  return Group;
})();
