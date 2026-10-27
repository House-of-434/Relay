export const SCOUT_GIT_ROLE = "scout";
export const AUTHORIZED_GITHUB_REPO = "House-of-434/house-of-434-site";
export const AUTHORIZED_GIT_DIRECTORY = "/home/cua/workspace/repos/House-of-434-house-of-434-site";
const PROTECTED_GIT_REFS = new Set(["main", "master", "production"]);
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_PATTERN = /^relay\/[A-Za-z0-9._-]{1,100}$/;
const UNSAFE_COMMAND_CHARACTERS = new Set(["`", "|", "&", ";", "<", ">", "(", ")", "$", "\\"]);

export type RelayGitOperation =
  | { kind: "auth-status" }
  | { kind: "clone"; repo: string }
  | { kind: "checkout"; branch: string }
  | { kind: "commit"; message: string }
  | { kind: "push"; branch: string }
  | { kind: "create-pr"; branch: string; title: string; body: string };

export type RelayGitParseResult =
  | { ok: true; operation: RelayGitOperation }
  | { ok: false; status: number; error: string };

export type RelayGitAuthorizationResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tokenizeRelayGitCommand(command: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let inWord = false;
  for (const character of command) {
    // Shell metacharacters are rejected only outside quotes. Quoted commit and
    // PR text is always re-quoted by buildRelayGitShell, while repository and
    // branch fields still go through their allowlists in authorization.
    if (quote === null && UNSAFE_COMMAND_CHARACTERS.has(character)) return null;
    const code = character.codePointAt(0) ?? 0;
    if (code === 0x7f || (code < 0x20 && character !== " " && character !== "\t" && character !== "\n" && character !== "\r")) return null;
    if (quote === null && (character === '"' || character === "'")) {
      quote = character;
      inWord = true;
      continue;
    }
    if (quote !== null && character === quote) {
      quote = null;
      continue;
    }
    if (quote === null && (character === " " || character === "\t" || character === "\n" || character === "\r")) {
      if (inWord) {
        words.push(word);
        word = "";
        inWord = false;
      }
      continue;
    }
    word += character;
    inWord = true;
  }
  if (quote !== null) return null;
  if (inWord) words.push(word);
  return words;
}

function parseCreatePr(words: string[]): RelayGitParseResult {
  const values: Record<string, string> = {};
  for (let index = 2; index < words.length; index += 2) {
    const name = words[index];
    const value = words[index + 1];
    if (name !== "--branch" && name !== "--title" && name !== "--body") {
      return { ok: false, status: 400, error: "create-pr accepts only --branch, --title, and --body" };
    }
    if (value === undefined || value.trim().length === 0 || values[name] !== undefined) {
      return { ok: false, status: 400, error: "create-pr requires one --branch, --title, and --body value" };
    }
    values[name] = value;
  }
  const branch = values["--branch"];
  const title = values["--title"];
  const body = values["--body"];
  if (!branch || !title || !body) {
    return { ok: false, status: 400, error: "create-pr requires --branch, --title, and --body" };
  }
  if (title.length > 256 || body.length > 4000) {
    return { ok: false, status: 400, error: "create-pr title and body are too long" };
  }
  return { ok: true, operation: { kind: "create-pr", branch, title, body } };
}

export function parseRelayGitCommand(command: unknown): RelayGitParseResult {
  if (typeof command !== "string") return { ok: false, status: 400, error: "a relay-git command is required" };
  const words = tokenizeRelayGitCommand(command);
  if (!words || words.length === 0 || words[0] !== "relay-git") {
    return { ok: false, status: 400, error: "relay-git commands must start with relay-git" };
  }
  const operation = words[1];
  if (operation === "auth-status") {
    if (words.length !== 2) return { ok: false, status: 400, error: "auth-status takes no arguments" };
    return { ok: true, operation: { kind: "auth-status" } };
  }
  if (operation === "clone") {
    if (words.length !== 3 || !REPO_PATTERN.test(words[2] ?? "")) {
      return { ok: false, status: 400, error: "clone requires one repository in owner/name form" };
    }
    return { ok: true, operation: { kind: "clone", repo: words[2] as string } };
  }
  if (operation === "checkout") {
    if (words.length !== 3 || !words[2]?.trim()) {
      return { ok: false, status: 400, error: "checkout requires one branch" };
    }
    return { ok: true, operation: { kind: "checkout", branch: words[2] as string } };
  }
  if (operation === "commit") {
    if (words.length !== 3 || !words[2]?.trim()) {
      return { ok: false, status: 400, error: "commit requires one message" };
    }
    if ((words[2] as string).length > 500) return { ok: false, status: 400, error: "commit messages are limited to 500 characters" };
    return { ok: true, operation: { kind: "commit", message: words[2] as string } };
  }
  if (operation === "push") {
    if (words.length !== 3 || !words[2]?.trim()) {
      return { ok: false, status: 400, error: "push requires one branch" };
    }
    return { ok: true, operation: { kind: "push", branch: words[2] as string } };
  }
  if (operation === "create-pr") return parseCreatePr(words);
  return { ok: false, status: 400, error: "unsupported relay-git operation" };
}

function branchForOperation(operation: RelayGitOperation): string | null {
  if (operation.kind === "checkout" || operation.kind === "push" || operation.kind === "create-pr") return operation.branch;
  return null;
}

export function authorizeRelayGitOperation(input: {
  senderRole: string | undefined;
  command: string;
  operation: RelayGitOperation;
  token: string | null | undefined;
}): RelayGitAuthorizationResult {
  if (input.senderRole !== SCOUT_GIT_ROLE) {
    return { ok: false, status: 403, error: "repository operations are available only to Scout" };
  }
  if (typeof input.command !== "string" || input.command.length === 0) {
    return { ok: false, status: 400, error: "a repository operation command is required" };
  }
  if (!input.token) return { ok: false, status: 409, error: "the workspace token is not configured" };
  if (input.command.includes(input.token)) {
    return { ok: false, status: 400, error: "repository commands must not contain the workspace token" };
  }
  if ("repo" in input.operation && input.operation.repo !== AUTHORIZED_GITHUB_REPO) {
    return { ok: false, status: 403, error: `repository operations are limited to ${AUTHORIZED_GITHUB_REPO}` };
  }
  const branch = branchForOperation(input.operation);
  if (branch !== null) {
    if (PROTECTED_GIT_REFS.has(branch)) {
      return { ok: false, status: 403, error: `protected branch operations are not allowed: ${branch}` };
    }
    if (!BRANCH_PATTERN.test(branch)) {
      return { ok: false, status: 403, error: "repository writes are limited to relay/ branches" };
    }
  }
  return { ok: true };
}

export function githubWorkspaceEnvironment(token: string): Record<string, string> {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
    GIT_CONFIG_VALUE_0: "!gh auth git-credential",
  };
}

export function redactRelayGitSecret(text: string, token: string): string {
  if (token.length === 0) return text;
  return text.split(token).join("[redacted-secret]");
}

function gitPrelude(): string {
  return [
    "set -e",
    "export GIT_TERMINAL_PROMPT=0",
    "export GIT_CONFIG_COUNT=1",
    "export GIT_CONFIG_KEY_0=credential.https://github.com.helper",
    "export GIT_CONFIG_VALUE_0='!gh auth git-credential'",
  ].join("; ");
}

export function buildRelayGitShell(operation: RelayGitOperation): string {
  const directory = shellQuote(AUTHORIZED_GIT_DIRECTORY);
  const repo = shellQuote(AUTHORIZED_GITHUB_REPO);
  const prelude = gitPrelude();
  if (operation.kind === "auth-status") return `${prelude}; gh auth status`;
  if (operation.kind === "clone") {
    return [
      prelude,
      `if [ -d ${directory}/.git ]; then git -C ${directory} fetch origin;`,
      `else mkdir -p ${directory} && gh repo clone ${repo} ${directory}; fi`,
    ].join("; ");
  }
  if (operation.kind === "checkout") {
    const branch = shellQuote(operation.branch);
    return `${prelude}; git -C ${directory} fetch origin && (git -C ${directory} switch ${branch} 2>/dev/null || git -C ${directory} switch -C ${branch} --track origin/main)`;
  }
  if (operation.kind === "commit") {
    return `${prelude}; git -C ${directory} add -A && git -C ${directory} commit -m ${shellQuote(operation.message)}`;
  }
  if (operation.kind === "push") {
    return `${prelude}; git -C ${directory} push -u origin ${shellQuote(operation.branch)}`;
  }
  return `${prelude}; gh pr create --repo ${repo} --head ${shellQuote(operation.branch)} --base main --title ${shellQuote(operation.title)} --body ${shellQuote(operation.body)}`;
}
