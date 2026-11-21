interface Preferences {
  agents?: string[];
}

function selected(preferences: Preferences): boolean {
  return preferences.agents?.includes("redcode") === true;
}

console.log(selected({ agents: ["redcode"] }), selected({}), selected({ agents: ["other"] }));
