import { query } from "./_generated/server";
import { v } from "convex/values";

export const status = query({
  args: {},
  returns: v.object({ ok: v.boolean(), backend: v.string() }),
  handler: async () => ({ ok: true, backend: "convex" }),
});
