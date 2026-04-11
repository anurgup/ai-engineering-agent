/**
 * Lazy singletons for external service clients.
 * Import from here instead of calling `new GitHubClient()` inline.
 */

import { GitHubClient } from "../tools/github.js";
import { NotionClient } from "../tools/notion.js";

let _github: GitHubClient | null = null;
let _notion: NotionClient | null = null;

export function getGitHubClient(): GitHubClient {
  return (_github ??= new GitHubClient());
}

export function getNotionClient(): NotionClient {
  return (_notion ??= new NotionClient());
}
