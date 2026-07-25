import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";

import type {
  IntegrationRecord,
  RemoteActionRecord,
} from "./domain.js";
import { ArkTeamError } from "./errors.js";

export interface RemoteTarget {
  remote_name: string;
  repository: string;
}

export interface RemoteExecutionResult {
  pull_request_url: string;
}

export interface RemoteActionExecutor {
  inspect(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<RemoteTarget>;
  execute(
    projectPath: string,
    integration: IntegrationRecord,
    action: RemoteActionRecord,
  ): Promise<RemoteExecutionResult>;
}

export interface GitHubRemoteActionExecutorOptions {
  git_path?: string;
  gh_path?: string;
  remote_name?: string;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface PullRequestListItem {
  url?: unknown;
  headRefName?: unknown;
  baseRefName?: unknown;
}

const execFileAsync = promisify(execFile);

export class GitHubRemoteActionExecutor implements RemoteActionExecutor {
  private readonly gitPath: string;
  private readonly ghPath: string;
  private readonly remoteName: string;

  constructor(options: GitHubRemoteActionExecutorOptions = {}) {
    this.gitPath = options.git_path?.trim() || "git";
    this.ghPath =
      options.gh_path?.trim() ||
      process.env.ARK_TEAM_GH_PATH?.trim() ||
      "gh";
    this.remoteName = options.remote_name?.trim() || "origin";
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(this.remoteName)) {
      throw new ArkTeamError(
        "INVALID_INPUT",
        "remote name contains unsupported characters",
      );
    }
  }

  async inspect(
    projectPath: string,
    integration: IntegrationRecord,
  ): Promise<RemoteTarget> {
    const repositoryRoot = await this.assertRepositoryRoot(projectPath);
    this.assertVerifiedPullRequestIntegration(integration);
    await this.assertLocalIntegrationRef(repositoryRoot, integration);
    const remoteUrl = (
      await this.git(repositoryRoot, [
        "remote",
        "get-url",
        this.remoteName,
      ], "REMOTE_ACTION_UNAVAILABLE", "Git remote is unavailable")
    ).stdout.trim();
    const repository = parseGitHubRepository(remoteUrl);
    await this.run(
      this.ghPath,
      ["auth", "status", "--hostname", "github.com"],
      repositoryRoot,
      "REMOTE_ACTION_UNAVAILABLE",
      "GitHub CLI authentication is unavailable",
    );
    const viewed = await this.run(
      this.ghPath,
      ["repo", "view", repository, "--json", "nameWithOwner"],
      repositoryRoot,
      "REMOTE_ACTION_UNAVAILABLE",
      "GitHub repository is unavailable",
    );
    const payload = parseJsonObject(viewed.stdout, "GitHub repository response");
    const canonicalRepository = payload.nameWithOwner;
    if (
      typeof canonicalRepository !== "string" ||
      canonicalRepository.toLowerCase() !== repository.toLowerCase()
    ) {
      throw new ArkTeamError(
        "REMOTE_ACTION_UNAVAILABLE",
        "GitHub CLI resolved a different repository",
      );
    }
    return {
      remote_name: this.remoteName,
      repository: canonicalRepository,
    };
  }

  async execute(
    projectPath: string,
    integration: IntegrationRecord,
    action: RemoteActionRecord,
  ): Promise<RemoteExecutionResult> {
    const repositoryRoot = await this.assertRepositoryRoot(projectPath);
    if (
      integration.state !== "remote_executing" ||
      integration.integration_commit_sha !== action.commit_sha ||
      integration.branch !== action.branch ||
      integration.target_branch !== action.target_branch ||
      action.remote_name !== this.remoteName ||
      action.status !== "executing"
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "remote executor received a different integration tuple",
      );
    }
    await this.assertLocalIntegrationRef(repositoryRoot, integration);
    const remoteUrl = (
      await this.git(
        repositoryRoot,
        ["remote", "get-url", action.remote_name],
        "REMOTE_ACTION_UNAVAILABLE",
        "Git remote is unavailable",
      )
    ).stdout.trim();
    if (
      parseGitHubRepository(remoteUrl).toLowerCase() !==
      action.repository.toLowerCase()
    ) {
      throw new ArkTeamError(
        "REMOTE_ACTION_UNAVAILABLE",
        "Git remote changed after approval",
      );
    }

    await this.git(
      repositoryRoot,
      [
        "push",
        "--porcelain",
        action.remote_name,
        `${action.commit_sha}:refs/heads/${action.branch}`,
      ],
      "REMOTE_ACTION_FAILED",
      "Approved integration push failed",
    );

    const existing = await this.findOpenPullRequest(repositoryRoot, action);
    if (existing !== null) {
      return { pull_request_url: existing };
    }
    const created = await this.run(
      this.ghPath,
      [
        "pr",
        "create",
        "--repo",
        action.repository,
        "--base",
        action.target_branch,
        "--head",
        action.branch,
        "--title",
        `Ark Team: ${integration.run_id}`,
        "--body",
        [
          `Automated Ark Team integration for ${integration.run_id}.`,
          "",
          `Verified integration commit: ${action.commit_sha}`,
          `Teams: ${integration.team_ids.join(", ")}`,
        ].join("\n"),
      ],
      repositoryRoot,
      "REMOTE_ACTION_FAILED",
      "Approved pull-request creation failed",
    );
    return {
      pull_request_url: parseGitHubPullRequestUrl(created.stdout),
    };
  }

  private async findOpenPullRequest(
    repositoryRoot: string,
    action: RemoteActionRecord,
  ): Promise<string | null> {
    const result = await this.run(
      this.ghPath,
      [
        "pr",
        "list",
        "--repo",
        action.repository,
        "--state",
        "open",
        "--head",
        action.branch,
        "--base",
        action.target_branch,
        "--json",
        "url,headRefName,baseRefName",
      ],
      repositoryRoot,
      "REMOTE_ACTION_FAILED",
      "Unable to inspect existing pull requests",
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new ArkTeamError(
        "REMOTE_ACTION_FAILED",
        "GitHub pull-request list returned invalid JSON",
        { cause: error },
      );
    }
    if (!Array.isArray(parsed) || parsed.length > 1) {
      throw new ArkTeamError(
        "REMOTE_ACTION_FAILED",
        "Expected at most one matching open pull request",
      );
    }
    const item = parsed[0] as PullRequestListItem | undefined;
    if (item === undefined) {
      return null;
    }
    if (
      item.headRefName !== action.branch ||
      item.baseRefName !== action.target_branch ||
      typeof item.url !== "string"
    ) {
      throw new ArkTeamError(
        "REMOTE_ACTION_FAILED",
        "Existing pull request does not match the approved tuple",
      );
    }
    return parseGitHubPullRequestUrl(item.url);
  }

  private async assertRepositoryRoot(projectPath: string): Promise<string> {
    let requested: string;
    try {
      requested = await realpath(projectPath);
    } catch (error) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "project repository path is unavailable",
        { cause: error },
      );
    }
    const root = (
      await this.git(
        requested,
        ["rev-parse", "--show-toplevel"],
        "REMOTE_ACTION_UNAVAILABLE",
        "Project is not a Git repository",
      )
    ).stdout.trim();
    let resolvedRoot: string;
    try {
      resolvedRoot = await realpath(root);
    } catch (error) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Git repository root is unavailable",
        { cause: error },
      );
    }
    if (resolvedRoot !== requested) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "remote actions require the exact repository root",
      );
    }
    return resolvedRoot;
  }

  private assertVerifiedPullRequestIntegration(
    integration: IntegrationRecord,
  ): void {
    if (
      integration.strategy !== "pull_request" ||
      integration.state !== "verified" ||
      integration.integration_commit_sha === null
    ) {
      throw new ArkTeamError(
        "INVALID_TRANSITION",
        "remote inspection requires a verified pull-request integration",
      );
    }
  }

  private async assertLocalIntegrationRef(
    repositoryRoot: string,
    integration: IntegrationRecord,
  ): Promise<void> {
    const expected = integration.integration_commit_sha;
    const actual = (
      await this.git(
        repositoryRoot,
        ["rev-parse", `refs/heads/${integration.branch}`],
        "UNSAFE_AGENT_WORKSPACE",
        "Integration branch is unavailable",
      )
    ).stdout.trim();
    if (expected === null || actual !== expected) {
      throw new ArkTeamError(
        "UNSAFE_AGENT_WORKSPACE",
        "Integration branch changed after verification",
      );
    }
  }

  private git(
    cwd: string,
    argv: string[],
    code: "REMOTE_ACTION_FAILED" | "REMOTE_ACTION_UNAVAILABLE" | "UNSAFE_AGENT_WORKSPACE",
    message: string,
  ): Promise<CommandResult> {
    return this.run(this.gitPath, argv, cwd, code, message);
  }

  private async run(
    executable: string,
    argv: string[],
    cwd: string,
    code: "REMOTE_ACTION_FAILED" | "REMOTE_ACTION_UNAVAILABLE" | "UNSAFE_AGENT_WORKSPACE",
    message: string,
  ): Promise<CommandResult> {
    try {
      const result = await execFileAsync(executable, argv, {
        cwd,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      throw new ArkTeamError(code, message, { cause: error });
    }
  }
}

function parseGitHubRepository(remoteUrl: string): string {
  const value = remoteUrl.trim();
  let pathname: string;
  if (/^git@github\.com:/i.test(value)) {
    pathname = value.replace(/^git@github\.com:/i, "");
  } else {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch (error) {
      throw new ArkTeamError(
        "REMOTE_ACTION_UNAVAILABLE",
        "Only a GitHub HTTPS or SSH remote is supported",
        { cause: error },
      );
    }
    if (parsed.hostname.toLowerCase() !== "github.com") {
      throw new ArkTeamError(
        "REMOTE_ACTION_UNAVAILABLE",
        "Only github.com pull-request remotes are currently supported",
      );
    }
    pathname = parsed.pathname.replace(/^\/+/, "");
  }
  const repository = pathname.replace(/\.git$/i, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ArkTeamError(
      "REMOTE_ACTION_UNAVAILABLE",
      "GitHub remote does not identify one owner/repository",
    );
  }
  return repository;
}

function parseJsonObject(
  value: string,
  description: string,
): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    throw new ArkTeamError(
      "REMOTE_ACTION_UNAVAILABLE",
      `${description} is invalid JSON`,
      { cause: error },
    );
  }
  throw new ArkTeamError(
    "REMOTE_ACTION_UNAVAILABLE",
    `${description} is not an object`,
  );
}

function parseGitHubPullRequestUrl(value: string): string {
  const candidate = value.trim().split(/\s+/).find((part) =>
    /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?$/.test(part),
  );
  if (!candidate) {
    throw new ArkTeamError(
      "REMOTE_ACTION_FAILED",
      "GitHub CLI did not return a valid pull-request URL",
    );
  }
  return new URL(candidate).toString();
}
