/**
 * Slack notification utilities.
 * Send DMs to users and messages to channels.
 */

import type { App } from "@slack/bolt";
import type { SlackUser } from "./workflow/types.js";

let slackApp: App | null = null;

export function setSlackApp(app: App): void {
  slackApp = app;
}

// ── Send a DM to a user ───────────────────────────────────────────────────────

export async function notifyUser(slackUserId: string, text: string): Promise<void> {
  if (!slackApp) {
    console.log(`[notifier] DM to ${slackUserId}: ${text.slice(0, 80)}`);
    return;
  }

  try {
    // Open a DM channel then post
    const dm = await slackApp.client.conversations.open({ users: slackUserId });
    const channelId = dm.channel?.id;
    if (!channelId) throw new Error("Could not open DM channel");

    await slackApp.client.chat.postMessage({
      channel: channelId,
      text,
    });
  } catch (err) {
    console.error(`[notifier] Failed to DM ${slackUserId}:`, err);
  }
}

// ── Post to a channel ─────────────────────────────────────────────────────────

export async function notifyChannel(channelName: string, text: string): Promise<void> {
  if (!slackApp) {
    console.log(`[notifier] #${channelName}: ${text.slice(0, 80)}`);
    return;
  }

  try {
    await slackApp.client.chat.postMessage({
      channel: channelName,
      text,
    });
  } catch (err) {
    console.error(`[notifier] Failed to post to #${channelName}:`, err);
  }
}

// ── Look up a Slack user by name ──────────────────────────────────────────────

export async function lookupSlackUser(name: string): Promise<SlackUser | null> {
  if (!slackApp) return null;

  try {
    const result = await slackApp.client.users.list({});
    const members = result.members ?? [];

    const lower = name.toLowerCase();
    const found = members.find(
      (m) =>
        !m.is_bot &&
        !m.deleted &&
        (
          (m.name ?? "").toLowerCase().includes(lower) ||
          (m.real_name ?? "").toLowerCase().includes(lower) ||
          (m.profile?.display_name ?? "").toLowerCase().includes(lower)
        )
    );

    if (!found || !found.id) return null;

    return {
      id:       found.id,
      name:     found.name ?? "",
      realName: found.real_name ?? found.profile?.display_name ?? found.name ?? "",
      role:     "unknown",
    };
  } catch (err) {
    console.error(`[notifier] Failed to lookup user "${name}":`, err);
    return null;
  }
}

// ── Format helpers ────────────────────────────────────────────────────────────

export function slackMention(userId: string): string {
  return `<@${userId}>`;
}
