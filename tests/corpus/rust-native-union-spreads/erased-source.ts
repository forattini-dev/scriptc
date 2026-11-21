type Issue =
  | { code: "a"; path: number[]; message: string }
  | { code: "b"; path: number[]; message: string };

function makeIssue(issueData: any, path: number[]): Issue {
  return { ...issueData, path, message: "ready" };
}

console.log(JSON.stringify(makeIssue({ code: "b", extra: 7 }, [1, 2])));
