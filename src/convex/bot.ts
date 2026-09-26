import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const POLICIES = ["accept", "decline", "required-only", "download-and-accept"] as const;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

/** Read the signed-in user's bot settings, or null before the first save. */
export const getSettings = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return null;
    const existing = await ctx.db
      .query("botSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return existing ?? null;
  },
});

/** Create the default settings row for the user if missing; returns it. */
export const ensureSettings = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not signed in");
    const existing = await ctx.db
      .query("botSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    if (existing) return existing;
    const id = await ctx.db.insert("botSettings", {
      userId,
      username: "PancakeBot",
      hasPassword: false,
      loginCommand: "/login {password}",
      registerCommand: "/register {password} {password2}",
      resourcePackPolicy: "accept",
      antiIdle: true,
      reconnectEnabled: true,
      reconnectMaxAttempts: 10,
      updateSeq: 0,
    });
    return await ctx.db.get(id);
  },
});

/**
 * Patch settings. The password is passed separately and NEVER persisted —
 * it only flips the stored `hasPassword` flag. Returns the new updateSeq so
 * the client can apply settings to the in-memory bot exactly once.
 */
export const saveSettings = mutation({
  args: {
    username: v.string(),
    password: v.optional(v.string()),
    loginCommand: v.string(),
    registerCommand: v.string(),
    resourcePackPolicy: v.string(),
    antiIdle: v.boolean(),
    reconnectEnabled: v.boolean(),
    reconnectMaxAttempts: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not signed in");

    const username = args.username.trim();
    if (!username) throw new Error("Username is required");
    if (!POLICIES.includes(args.resourcePackPolicy as (typeof POLICIES)[number])) {
      throw new Error(`Unknown resource-pack policy "${args.resourcePackPolicy}"`);
    }

    const existing = await ctx.db
      .query("botSettings")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();

    const hasPassword = args.password !== undefined
      ? args.password.length > 0
      : (existing?.hasPassword ?? false);

    const updateSeq = (existing?.updateSeq ?? 0) + 1;

    const fields = {
      username,
      hasPassword,
      loginCommand: args.loginCommand.trim() || "/login {password}",
      registerCommand: args.registerCommand.trim() || "/register {password} {password2}",
      resourcePackPolicy: args.resourcePackPolicy,
      antiIdle: args.antiIdle,
      reconnectEnabled: args.reconnectEnabled,
      reconnectMaxAttempts: clamp(args.reconnectMaxAttempts, 1, 50),
      updateSeq,
    };

    if (existing) {
      await ctx.db.patch(existing._id, fields);
    } else {
      await ctx.db.insert("botSettings", { userId, ...fields });
    }
    return { updateSeq };
  },
});

/** Append a dashboard event (already redacted by the client logger). */
export const recordEvent = mutation({
  args: {
    level: v.string(),
    scope: v.string(),
    message: v.string(),
    at: v.number(),
  },
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return;
    await ctx.db.insert("botEvents", { userId, ...args });
    // Keep the per-user log bounded: drop everything older than the newest 200.
    const recent = await ctx.db
      .query("botEvents")
      .withIndex("by_user_time", (q) => q.eq("userId", userId).gt("at", Date.now() - 7 * 24 * 3600 * 1000))
      .collect();
    if (recent.length > 200) {
      const stale = recent
        .sort((a, b) => a.at - b.at)
        .slice(0, recent.length - 200);
      for (const doc of stale) await ctx.db.delete(doc._id);
    }
  },
});

/** Newest dashboard events for the current user. */
export const recentEvents = query({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return [];
    const docs = await ctx.db
      .query("botEvents")
      .withIndex("by_user_time", (q) => q.eq("userId", userId).gt("at", Date.now() - 24 * 3600 * 1000))
      .collect();
    return docs.sort((a, b) => b.at - a.at).slice(0, 100);
  },
});

/** Clear the dashboard event log. */
export const clearEvents = mutation({
  args: {},
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (userId === null) return;
    const docs = await ctx.db
      .query("botEvents")
      .withIndex("by_user_time", (q) => q.eq("userId", userId))
      .collect();
    for (const doc of docs) await ctx.db.delete(doc._id);
  },
});
