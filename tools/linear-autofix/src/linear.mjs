import { config } from "./config.mjs";

const ENDPOINT = "https://api.linear.app/graphql";

export async function gql(query, variables = {}) {
  if (!config.linearApiKey) throw new Error("LINEAR_API_KEY is not set");
  const auth = config.linearApiKey.startsWith("lin_api_")
    ? config.linearApiKey
    : `Bearer ${config.linearApiKey}`;
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok)
    throw new Error(
      `Linear HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`,
    );
  const json = await res.json();
  if (json.errors?.length)
    throw new Error(
      `Linear GraphQL: ${JSON.stringify(json.errors).slice(0, 500)}`,
    );
  return json.data;
}

const ISSUE_FIELDS = `
  id identifier title description url branchName priority priorityLabel
  createdAt updatedAt
  state { id name type }
  team { id key name }
  project { name }
  labels { nodes { id name } }
  attachments { nodes { title url } }
  comments(first: 50) { nodes { id body createdAt user { name displayName } } }
`;

/** Every issue assigned to the API key's user in the configured states. */
export async function fetchAssignedIssues(states = config.linearStates) {
  const issues = [];
  let after = null;
  for (;;) {
    const data = await gql(
      `query($after: String, $states: [String!]) {
        issues(first: 50, after: $after, filter: {
          assignee: { isMe: { eq: true } },
          state: { name: { in: $states } }
        }) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { after, states },
    );
    issues.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) break;
    after = data.issues.pageInfo.endCursor;
  }
  return issues;
}

export async function fetchIssue(identifier) {
  const data = await gql(
    `query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
    { id: identifier },
  );
  return data.issue;
}

const teamCache = new Map();
async function teamMeta(teamId) {
  if (!teamCache.has(teamId)) {
    const data = await gql(
      `query($id: String!) { team(id: $id) {
        states { nodes { id name } }
        labels { nodes { id name } }
      } }`,
      { id: teamId },
    );
    teamCache.set(teamId, data.team);
  }
  return teamCache.get(teamId);
}

async function labelId(teamId, name) {
  const team = await teamMeta(teamId);
  const found = team.labels.nodes.find((l) => l.name === name);
  if (found) return found.id;
  if (config.dryRun) return null;
  const data = await gql(
    `mutation($input: IssueLabelCreateInput!) {
      issueLabelCreate(input: $input) { success issueLabel { id name } }
    }`,
    { input: { name, teamId, color: "#8b5cf6" } },
  );
  team.labels.nodes.push(data.issueLabelCreate.issueLabel);
  return data.issueLabelCreate.issueLabel.id;
}

function dry(what) {
  console.log(`[dry-run] linear: ${what}`);
}

export async function comment(issue, body) {
  const text = `${config.botMarker}\n${body}`;
  if (config.dryRun) return dry(`comment on ${issue.identifier}:\n${text}`);
  await gql(
    `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
    { input: { issueId: issue.id, body: text } },
  );
}

export async function addLabel(issue, name) {
  if (config.dryRun) return dry(`add label ${name} to ${issue.identifier}`);
  const id = await labelId(issue.teamId, name);
  await gql(
    `mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }`,
    {
      id: issue.id,
      labelId: id,
    },
  );
}

export async function removeLabel(issue, name) {
  const team = await teamMeta(issue.teamId);
  const found = team.labels.nodes.find((l) => l.name === name);
  if (!found) return;
  if (config.dryRun)
    return dry(`remove label ${name} from ${issue.identifier}`);
  await gql(
    `mutation($id: String!, $labelId: String!) { issueRemoveLabel(id: $id, labelId: $labelId) { success } }`,
    { id: issue.id, labelId: found.id },
  );
}

export async function setState(issue, stateName) {
  const team = await teamMeta(issue.teamId);
  const state = team.states.nodes.find((s) => s.name === stateName);
  if (!state) {
    console.warn(
      `[${issue.identifier}] team has no state named ${stateName}; leaving state alone`,
    );
    return;
  }
  if (config.dryRun)
    return dry(`set ${issue.identifier} state -> ${stateName}`);
  await gql(
    `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
    {
      id: issue.id,
      input: { stateId: state.id },
    },
  );
}

/** Markdown rendering of an issue for prompts. */
export function renderIssue(issue) {
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    ``,
    `- URL: ${issue.url}`,
    `- State: ${issue.state?.name ?? "?"} · Priority: ${issue.priorityLabel ?? issue.priority}`,
    `- Team: ${issue.team?.name ?? "?"} · Project: ${issue.project?.name ?? "none"}`,
    `- Labels: ${(issue.labels?.nodes ?? []).map((l) => l.name).join(", ") || "none"}`,
    `- Suggested branch: ${issue.branchName}`,
    ``,
    `## Description`,
    ``,
    issue.description?.trim() || "_(empty)_",
  ];
  const attachments = issue.attachments?.nodes ?? [];
  if (attachments.length) {
    lines.push(``, `## Attachments`, ``);
    for (const a of attachments)
      lines.push(`- ${a.title ?? "attachment"}: ${a.url}`);
  }
  const comments = (issue.comments?.nodes ?? []).filter(
    (c) => !c.body.includes(config.botMarker),
  );
  if (comments.length) {
    lines.push(``, `## Comments`, ``);
    for (const c of comments) {
      const who = c.user?.displayName ?? c.user?.name ?? "unknown";
      lines.push(`### ${who} · ${c.createdAt}`, ``, c.body.trim(), ``);
    }
  }
  return lines.join("\n");
}
