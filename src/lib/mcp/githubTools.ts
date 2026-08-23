import { McpTool } from "../types";

/**
 * Explicit allow-list of read-only tools exposed by the official GitHub MCP
 * server (https://githubcopilot.com/mcp, github/github-mcp-server).
 *
 * Security note: this is intentionally an ALLOW-list (not a deny-list).
 * Keyword-based deny-lists silently miss write tools whose names do not
 * contain words like "create"/"update"/"delete" (e.g. merge_pull_request,
 * add_issue_comment, request_copilot_review). With an allow-list, any tool
 * that is not explicitly listed here is treated as a WRITE tool and is
 * filtered out when GitHub Write Mode is disabled.
 */
export const GITHUB_READ_ONLY_TOOLS: Set<string> = new Set([
  // User / repository basics
  "get_me",
  "get_file_contents",
  "list_repository_tree",

  // Commits & history
  "get_commit",
  "list_commits",

  // Branches & tags
  "list_branches",
  "list_tags",
  "get_tag",

  // Releases
  "get_latest_release",
  "list_releases",
  "get_release_by_tag",

  // Issues
  "list_issues",
  "get_issue",
  "list_issue_comments",
  "get_issue_comments",
  "list_sub_issues",

  // Search
  "search_code",
  "search_issues",
  "search_repositories",
  "search_users",

  // Pull requests
  "list_pull_requests",
  "get_pull_request",
  "get_pull_request_files",
  "get_pull_request_status",
  "get_pull_request_diff",

  // Notifications
  "list_notifications",
  "get_notification_details",

  // Security alerts
  "list_dependabot_alerts",
  "list_code_scanning_alerts",
  "list_secret_scanning_alerts",
  "get_global_security_advisory",

  // Actions (CI)
  "list_workflows",
  "list_workflow_runs",
  "get_workflow_run",
  "list_workflow_jobs",
  "get_job_logs",
  "get_workflow_run_usage",

  // Organizations / teams
  "list_teams",
  "list_team_members",

  // Projects (Projects v2, read-only subset)
  "list_projects",
  "get_project",
  "list_project_fields",
  "list_project_items",

  // Stars
  "list_starred_repositories",
]);

/**
 * Filters MCP tools for the GitHub preset.
 *
 * When write mode is disabled (`writeModeEnabled` is false or undefined),
 * only tools from GITHUB_READ_ONLY_TOOLS are returned. When enabled,
 * all tools are returned unchanged.
 */
export function filterGithubTools(tools: McpTool[], writeModeEnabled: boolean): McpTool[] {
  if (writeModeEnabled === true) {
    return tools;
  }
  return tools.filter((t: McpTool) => GITHUB_READ_ONLY_TOOLS.has(t.name));
}
