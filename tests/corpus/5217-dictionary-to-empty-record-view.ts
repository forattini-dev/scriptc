type MachineProfile = {
  schema: number;
  tools: {};
};

const tools: Record<string, boolean> = { compiler: true };
const profile: MachineProfile = { schema: 1, tools };
console.log(Object.keys(profile.tools).join(","));
