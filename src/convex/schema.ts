import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // add other tables here

    // Per-user bot configuration. The password itself is never stored — only
    // whether one is configured — so the dashboard can never leak it.
    botSettings: defineTable({
      userId: v.id("users"),
      username: v.string(),
      hasPassword: v.boolean(),
      loginCommand: v.string(),
      registerCommand: v.string(),
      resourcePackPolicy: v.string(),
      antiIdle: v.boolean(),
      reconnectEnabled: v.boolean(),
      reconnectMaxAttempts: v.number(),
      updateSeq: v.number(),
    })
      .index("by_user", ["userId"]),

    // Rolling per-user dashboard log of significant bot events (session
    // lifecycle, auth results, pack decisions). Debug noise stays client-side.
    botEvents: defineTable({
      userId: v.id("users"),
      at: v.number(),
      level: v.string(),
      scope: v.string(),
      message: v.string(),
    })
      .index("by_user_time", ["userId", "at"]),

    // tableName: defineTable({
    //   ...
    //   // table fields
    // }).index("by_field", ["field"])
  },
  {
    schemaValidation: false,
  },
);

export default schema;
