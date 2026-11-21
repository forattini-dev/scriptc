const params = new URLSearchParams("a=1&b=two&a=3");

for (const [key, value] of params.entries()) console.log("entry", key, value);
for (const key of params.keys()) console.log("key", key);
for (const value of params.values()) console.log("value", value);
