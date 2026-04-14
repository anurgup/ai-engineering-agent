/**
 * Core types for the SDLC Workflow Engine.
 */

export type TicketStage =
  | "backlog"       // just created
  | "in_dev"        // being developed (AI or human)
  | "in_review"     // PR open, awaiting review
  | "in_testing"    // deployed to staging, tester notified
  | "done"          // ticket closed
  | "blocked";      // stuck / needs attention

export type AssigneeRole = "ba" | "developer" | "tester" | "unknown";

export type DeveloperMode = "ai" | "human" | "pending";
export type TestMode      = "ai" | "human" | "pending";

export interface WorkflowTicket {
  issueNumber:      number;
  title:            string;
  stage:            TicketStage;
  createdBy:        string;          // Slack user ID of creator
  assigneeSlackId?: string;          // Slack user ID of developer assignee
  assigneeName?:    string;          // Human-readable developer name
  testerSlackId?:   string;          // Slack user ID of tester (separate from developer)
  testerName?:      string;          // Human-readable tester name
  assigneeRole:     AssigneeRole;
  developerMode:    DeveloperMode;
  testMode:         TestMode;
  prNumber?:        number;
  prUrl?:           string;
  branchName?:      string;
  testCases?:       string;          // AI-generated test cases
  githubUrl?:       string;
  notionUrl?:       string;          // Notion doc URL (set by agent)
  notionPageId?:    string;          // Notion page ID — used to update in place instead of creating new
  // Timestamps for SLA tracking
  createdAt:        Date;
  stageChangedAt:   Date;
  updatedAt:        Date;
  // Stage history for audit trail
  history:          StageEvent[];
}

export interface StageEvent {
  stage:     TicketStage;
  changedBy: string;   // Slack user ID or "ai"
  note?:     string;
  at:        Date;
}

export interface SlackUser {
  id:          string;   // Slack user ID (U0ABC123)
  name:        string;   // display name
  realName:    string;   // full name
  role:        AssigneeRole;
}

// SLA thresholds in hours per stage
export const SLA_HOURS: Record<TicketStage, number> = {
  backlog:    24,
  in_dev:     48,
  in_review:  24,
  in_testing: 24,
  done:       0,
  blocked:    4,
};
