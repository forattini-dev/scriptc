interface Preferences {
  crashHandoff?: boolean;
  label?: string;
}

function remember(preferences: Preferences): string {
  return preferences.crashHandoff === false ? "declined" : "enabled";
}

const patch = { crashHandoff: false };
console.log(remember(patch));
