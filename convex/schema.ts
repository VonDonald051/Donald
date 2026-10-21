import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Transitional table for importing the existing encrypted JSON database while
// the Node routes are ported to typed Convex functions. Payloads remain
// server-only; all lookup fields needed by future functions are indexed here.
const legacyCollection = v.union(
  v.literal("users"), v.literal("groups"), v.literal("safeCodes"),
  v.literal("requests"), v.literal("messages"), v.literal("notifications"),
  v.literal("audit"), v.literal("resets"), v.literal("sessions"), v.literal("items"),
  v.literal("registrationFees"), v.literal("cashLoans"), v.literal("itemLoans"),
  v.literal("savings"), v.literal("fines"), v.literal("reversals"),
  v.literal("memberProfiles"), v.literal("notes"), v.literal("branding"),
  v.literal("agreements"), v.literal("exports"), v.literal("systemAgreements"),
  v.literal("metadata")
);

export default defineSchema({
  legacyRecords: defineTable({
    collection: legacyCollection,
    legacyId: v.number(),
    data: v.any(),
    email: v.optional(v.string()),
    sessionTokenHash: v.optional(v.string()),
    groupId: v.optional(v.number()),
    userId: v.optional(v.number()),
    status: v.optional(v.string()),
  })
    .index("by_collection_and_legacy_id", ["collection", "legacyId"])
    .index("by_collection_and_email", ["collection", "email"])
    .index("by_collection_and_session_token_hash", ["collection", "sessionTokenHash"])
    .index("by_collection_and_group_id", ["collection", "groupId"])
    .index("by_collection_and_user_id", ["collection", "userId"])
    .index("by_collection_and_status", ["collection", "status"]),
});
