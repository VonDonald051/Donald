import { internalMutation, internalQuery } from "./_generated/server";
import { v } from "convex/values";

const nullableString = v.union(v.string(), v.null());

export const publicGroups = internalQuery({
  args: {},
  returns: v.array(v.object({ id: v.number(), name: v.string() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups"))
      .take(300);
    return rows
      .map((row) => row.data as { id?: number; name?: string; suspended?: boolean; isStaffChama?: boolean })
      .filter((group) => !group.isStaffChama && !group.suspended && typeof group.id === "number" && typeof group.name === "string")
      .map((group) => ({ id: group.id!, name: group.name! }));
  },
});

export const publicBranding = internalQuery({
  args: {},
  returns: v.object({ name: v.string(), logo: nullableString, colors: v.union(v.any(), v.null()) }),
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "branding"))
      .take(100);
    const active = rows.map((row) => row.data as { id?: number; name?: string; logo?: string | null; colors?: unknown; rolledBack?: boolean })
      .filter((row) => !row.rolledBack)
      .sort((a, b) => Number(a.id || 0) - Number(b.id || 0));
    const current = active.at(-1);
    return current
      ? { name: current.name || "VonDonald051 Savings", logo: current.logo || null, colors: current.colors ?? null }
      : { name: "VonDonald051 Savings", logo: null, colors: null };
  },
});

// Read-only V Super Admin landing data. Keep password hashes, crypto keys,
// recovery data, and session details out of all dashboard responses.
export const vsaOverview = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const [users, groups, safeCodes, requests, messages, audit] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users")).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups")).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "safeCodes")).take(2000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_status", q => q.eq("collection", "requests").eq("status", "pending")).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "messages")).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "audit")).order("desc").take(5000),
    ]);
    const liveUsers = users.map(row => row.data as Record<string, unknown>).filter(user => !user.deleted);
    const codes = safeCodes.map(row => row.data as Record<string, unknown>);
    const metadata = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const settings = ((metadata?.data as { settings?: Record<string, string> } | undefined)?.settings || {});
    return {
      users: Object.fromEntries(["v_super_admin", "super_admin", "admin", "group_admin", "member"].map(role =>
        [role, liveUsers.filter(user => user.role === role).length])),
      groups: groups.filter(row => !(row.data as { isStaffChama?: boolean }).isStaffChama).length,
      safeCodes: { active: codes.filter(code => code.active && !code.usedBy).length, used: codes.filter(code => Boolean(code.usedBy)).length },
      locked: liveUsers.filter(user => user.locked).length,
      disabled: liveUsers.filter(user => user.disabled).length,
      pendingRequests: requests.length,
      messages: messages.length,
      safeCodeRequired: settings.safe_code_required === "1",
      securityMonitorActive: true,
      failedLoginIpThreshold: 4,
      auditEvents: audit.length,
    };
  },
});

export const vsaUsers = internalQuery({
  args: { role: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, { role }) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users"))
      .take(5000);
    const users = rows.map(row => row.data as Record<string, unknown>)
      .filter(user => !user.deleted && (!role || user.role === role))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .map(user => ({
        id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email,
        name: `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim(), failed: Number(user.failed || 0),
        phone: user.phone, role: user.role, groupId: user.groupId || null, pic: user.pic || null,
        locked: Boolean(user.locked), disabled: Boolean(user.disabled),
        passwordChangeRequired: Boolean(user.passwordChangeRequired), createdAt: user.createdAt,
      }));
    return { users };
  },
});

export const unlockAccount = internalMutation({
  args: { ownerId: v.number(), userId: v.number() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const [ownerRow, userRow] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique(),
    ]);
    const owner = ownerRow?.data as { role?: string } | undefined;
    if (owner?.role !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role" };
    if (!userRow || (userRow.data as { deleted?: boolean }).deleted) return { status: 404, error: "User not found" };
    const user = userRow.data as Record<string, unknown>;
    await ctx.db.patch(userRow._id, { data: { ...user, locked: false, failed: 0, updatedAt: new Date().toISOString() } });
    return { status: 200, error: null };
  },
});

export const createManagedStaffAccount = internalMutation({
  args: { ownerId: v.number(), role: v.union(v.literal("super_admin"), v.literal("admin")), firstName: v.string(), lastName: v.string(), email: v.string(), phone: v.string(), passHash: v.string(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), errors: v.any(), user: v.any() }),
  handler: async (ctx, args) => {
    const owner = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique();
    if ((owner?.data as { role?: string } | undefined)?.role !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role", errors: null, user: null };
    const matches = await ctx.db.query("legacyRecords").withIndex("by_collection_and_email", q => q.eq("collection", "users").eq("email", args.email)).take(20);
    const errors: Record<string, string> = {};
    if (matches.some(row => !(row.data as { deleted?: boolean }).deleted)) errors.email = "Email already in use";
    const users = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users")).take(5000);
    const live = users.map(row => row.data as Record<string, unknown>).filter(user => !user.deleted);
    if (live.filter(user => user.role === args.role).length >= 2) errors.role = `The system supports at most two ${args.role === "admin" ? "Admin" : "Super Admin"} accounts`;
    if (Object.keys(errors).length) return { status: 400, error: null, errors, user: null };
    const meta = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const id = Number(counters.user || 0) + 1;
    const profileId = Number(counters.memberProfile || 0) + 1;
    const staffGroup = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups")).take(1000);
    const group = staffGroup.find(row => (row.data as { isStaffChama?: boolean }).isStaffChama)?.data as { id?: number } | undefined;
    const groupId = typeof group?.id === "number" ? group.id : null;
    const user = { id, firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone, role: args.role, groupId, passHash: args.passHash, passwordChangeRequired: true, pic: null, ecdhPub: null, failed: 0, locked: false, disabled: false, deleted: false, createdAt: args.now, updatedAt: args.now };
    await ctx.db.insert("legacyRecords", { collection: "users", legacyId: id, email: args.email, ...(groupId === null ? {} : { groupId }), data: user });
    await ctx.db.insert("legacyRecords", { collection: "memberProfiles", legacyId: profileId, userId: id, ...(groupId === null ? {} : { groupId }), data: { id: profileId, userId: id, groupId, registrationFeePaid: false, registrationFeePaidAt: null, agreementSigned: false, agreementSignedAt: null, weeklySavingTarget: 0, createdAt: args.now, updatedAt: args.now } });
    counters.user = id;
    counters.memberProfile = profileId;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    const safe = { id, firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone, role: args.role, groupId, locked: false, disabled: false, passwordChangeRequired: true };
    return { status: 201, error: null, errors: null, user: safe };
  },
});

export const updateManagedUser = internalMutation({
  args: { ownerId: v.number(), userId: v.number(), firstName: v.string(), lastName: v.string(), email: v.string(), phone: v.string(), groupId: v.union(v.number(), v.null()), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), user: v.any() }),
  handler: async (ctx, args) => {
    const [ownerRow, userRow] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique(),
    ]);
    const owner = ownerRow?.data as { role?: string } | undefined;
    if (owner?.role !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role", user: null };
    if (!userRow) return { status: 404, error: "User not found", user: null };
    const user = userRow.data as Record<string, unknown>;
    if (args.userId === args.ownerId) return { status: 400, error: "Use the Profile tab to edit your own account", user: null };
    if (user.role === "v_super_admin") return { status: 403, error: "Owner accounts cannot be edited here", user: null };
    const emailMatches = await ctx.db.query("legacyRecords").withIndex("by_collection_and_email", q => q.eq("collection", "users").eq("email", args.email)).take(20);
    if (emailMatches.some(row => Number((row.data as { id?: number }).id) !== args.userId && !(row.data as { deleted?: boolean }).deleted)) return { status: 400, error: "Email already in use", user: null };
    const previousGroup = user.groupId ?? null;
    if (["member", "group_admin"].includes(String(user.role)) && args.groupId !== null) {
      const groupRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups").eq("legacyId", args.groupId!)).unique();
      const group = groupRow?.data as { suspended?: boolean; isStaffChama?: boolean } | undefined;
      if (!group || group.isStaffChama || group.suspended) return { status: 400, error: "Choose an active savings group", user: null };
      const participants = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "users").eq("groupId", args.groupId!)).take(300);
      const count = participants.filter(row => Number((row.data as { id?: number }).id) !== args.userId && !(row.data as { deleted?: boolean }).deleted && ["member", "group_admin"].includes(String((row.data as { role?: string }).role))).length;
      if (count >= 30) return { status: 400, error: "This group has reached its 30-member limit", user: null };
    }
    const updated = { ...user, firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone, ...(user.role === "member" || user.role === "group_admin" ? { groupId: args.groupId } : {}), updatedAt: args.now };
    await ctx.db.patch(userRow._id, { email: args.email, ...(typeof updated.groupId === "number" ? { groupId: updated.groupId } : { groupId: undefined }), data: updated });
    if (["member", "group_admin"].includes(String(user.role))) {
      const profiles = await ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "memberProfiles").eq("userId", args.userId)).take(5);
      for (const profileRow of profiles) {
        const profile = profileRow.data as Record<string, unknown>;
        await ctx.db.patch(profileRow._id, { ...(args.groupId === null ? { groupId: undefined } : { groupId: args.groupId }), data: { ...profile, groupId: args.groupId, updatedAt: args.now } });
      }
    }
    if (previousGroup !== args.groupId) {
      const sessions = await ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "sessions").eq("userId", args.userId)).take(1000);
      for (const row of sessions) await ctx.db.delete(row._id);
    }
    return { status: 200, error: null, user: { id: user.id, firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone, role: user.role, groupId: updated.groupId ?? null, locked: user.locked, disabled: user.disabled } };
  },
});

export const deleteManagedUser = internalMutation({
  args: { ownerId: v.number(), userId: v.number(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const [ownerRow, userRow] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique(),
    ]);
    if (((ownerRow?.data as { role?: string } | undefined)?.role) !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role" };
    if (!userRow) return { status: 404, error: "User not found" };
    const user = userRow.data as Record<string, unknown>;
    if (user.role === "v_super_admin" || args.userId === args.ownerId) return { status: 403, error: "Owner accounts cannot be deleted here" };
    await ctx.db.patch(userRow._id, { data: { ...user, deleted: true, deletedAt: args.now } });
    const sessions = await ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "sessions").eq("userId", args.userId)).take(1000);
    for (const row of sessions) await ctx.db.delete(row._id);
    return { status: 200, error: null };
  },
});

export const toggleManagedUserDisabled = internalMutation({
  args: { ownerId: v.number(), userId: v.number(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), disabled: v.boolean() }),
  handler: async (ctx, args) => {
    const [ownerRow, userRow] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique(),
    ]);
    if (((ownerRow?.data as { role?: string } | undefined)?.role) !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role", disabled: false };
    if (!userRow) return { status: 404, error: "User not found", disabled: false };
    const user = userRow.data as Record<string, unknown>;
    if (args.userId === args.ownerId) return { status: 400, error: "You cannot disable your own account", disabled: Boolean(user.disabled) };
    if (user.role === "v_super_admin") return { status: 403, error: "Cannot disable a V Super Admin", disabled: Boolean(user.disabled) };
    const disabled = !user.disabled;
    await ctx.db.patch(userRow._id, { data: { ...user, disabled, updatedAt: args.now } });
    if (disabled) {
      const sessions = await ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "sessions").eq("userId", args.userId)).take(1000);
      for (const row of sessions) await ctx.db.delete(row._id);
    }
    return { status: 200, error: null, disabled };
  },
});

export const vsaGroups = internalQuery({
  args: { groupId: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, { groupId }) => {
    const groups = groupId === undefined
      ? await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups")).take(1000)
      : await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups").eq("legacyId", groupId)).take(1);
    const visible = groups.filter(row => !(row.data as { isStaffChama?: boolean }).isStaffChama);
    if (groupId !== undefined && !visible.length) return { status: 404, error: "Group not found" };
    const summaries = [];
    for (const row of visible) {
      const group = row.data as Record<string, unknown>;
      const id = Number(group.id || row.legacyId);
      const [userRows, cashRows, itemLoanRows, fineRows, itemRows] = await Promise.all([
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "users").eq("groupId", id)).take(300),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "cashLoans").eq("groupId", id)).take(3000),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "itemLoans").eq("groupId", id)).take(3000),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "fines").eq("groupId", id)).take(3000),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "items").eq("groupId", id)).take(1000),
      ]);
      const users = userRows.map(item => item.data as Record<string, unknown>).filter(user => !user.deleted && ["member", "group_admin"].includes(String(user.role)));
      const cash = cashRows.map(item => item.data as Record<string, unknown>);
      const itemLoans = itemLoanRows.map(item => item.data as Record<string, unknown>);
      const loans = [...cash, ...itemLoans];
      const fines = fineRows.map(item => item.data as Record<string, unknown>);
      const savings = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "savings").eq("groupId", id)).take(5000);
      const summary = {
        ...group,
        members: users.filter(user => user.role === "member").length,
        savingsCents: savings.reduce((total, item) => {
          const saving = item.data as { amountCents?: number; status?: string; reversed?: boolean };
          return total + (!saving.reversed && (!saving.status || saving.status === "verified") ? Number(saving.amountCents || 0) : 0);
        }, 0),
        admins: users.filter(user => user.role === "group_admin").length,
        pendingLoanRequests: loans.filter(loan => loan.status === "pending").length,
        activeLoans: loans.filter(loan => ["disbursed", "overdue"].includes(String(loan.status))).length,
        finesPaid: fines.filter(fine => fine.paid).reduce((total, fine) => total + Number(fine.amountCents || 0), 0),
        itemsBorrowed: itemLoans.filter(loan => ["disbursed", "overdue", "cleared"].includes(String(loan.status))).length,
        cashLoaned: cash.filter(loan => ["disbursed", "overdue", "cleared"].includes(String(loan.status))).reduce((total, loan) => total + Number(loan.amountCents || 0), 0),
      };
      if (groupId === undefined) summaries.push(summary);
      else summaries.push({
        group: summary,
        members: users.filter(user => user.role === "member").map(user => ({ id: user.id, firstName: user.firstName, lastName: user.lastName, name: `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim(), email: user.email, phone: user.phone, createdAt: user.createdAt })),
        admins: users.filter(user => user.role === "group_admin").map(user => ({ id: user.id, name: `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim(), email: user.email, phone: user.phone })),
        items: itemRows.map(item => item.data as Record<string, unknown>).filter(item => item.active !== false),
        loans: loans.map(loan => ({ id: loan.id, userId: loan.userId, type: loan.type || (loan.itemId ? "item" : "cash"), amountCents: loan.amountCents, itemName: loan.itemName, status: loan.status, createdAt: loan.createdAt })),
      });
    }
    return groupId === undefined ? { groups: summaries } : { status: 200, ...summaries[0] };
  },
});

export const vsaSafeCodes = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", q => q.eq("collection", "safeCodes"))
      .order("desc").take(300);
    const codes = [];
    for (const row of rows) {
      const code = row.data as Record<string, unknown>;
      const group = typeof code.groupId === "number"
        ? await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups").eq("legacyId", Number(code.groupId))).unique()
        : null;
      codes.push({ id: code.id, code: code.code, groupId: code.groupId, group: (group?.data as { name?: string } | undefined)?.name || "-", used: Boolean(code.usedBy), active: Boolean(code.active), createdAt: code.createdAt, usedAt: code.usedAt });
    }
    return { codes };
  },
});

export const updateSafeCodeRequirement = internalMutation({
  args: { ownerId: v.number(), required: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), safeCodeRequired: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique();
    const owner = ownerRow?.data as { role?: string } | undefined;
    if (owner?.role !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role", safeCodeRequired: false };
    if (args.required !== "0" && args.required !== "1") return { status: 400, error: "safe_code_required must be 0 or 1", safeCodeRequired: false };
    const meta = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const data = (meta?.data || {}) as { settings?: Record<string, string> };
    const settings = { ...(data.settings || {}), safe_code_required: args.required };
    if (meta) await ctx.db.patch(meta._id, { data: { ...data, settings } });
    return { status: 200, error: null, safeCodeRequired: args.required === "1" };
  },
});

export const revokeOwnerSafeCode = internalMutation({
  args: { ownerId: v.number(), codeId: v.number() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const ownerRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.ownerId)).unique();
    const owner = ownerRow?.data as { role?: string } | undefined;
    if (owner?.role !== "v_super_admin") return { status: 403, error: "Forbidden: insufficient role" };
    const row = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "safeCodes").eq("legacyId", args.codeId)).unique();
    if (!row) return { status: 404, error: "Code not found" };
    const code = row.data as Record<string, unknown>;
    if (code.usedBy) return { status: 400, error: "Cannot revoke a code that was already used" };
    await ctx.db.patch(row._id, { data: { ...code, active: false } });
    return { status: 200, error: null };
  },
});

export const vsaAudit = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", q => q.eq("collection", "audit"))
      .order("desc").take(250);
    return { audit: rows.map(row => row.data) };
  },
});

export const adminAudit = internalQuery({
  args: {},
  returns: v.any(),
  handler: async (ctx) => {
    const rows = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "audit")).order("desc").take(300);
    return { entries: rows.map(row => {
      const entry = row.data as Record<string, unknown>;
      return { id: entry.id, actor: entry.actor, actorRole: entry.actorRole, action: entry.action, ip: entry.ip, at: entry.at, prevHash: entry.prevHash, hash: entry.hash };
    }) };
  },
});

export const systemAgreementList = internalQuery({
  args: { groupId: v.union(v.number(), v.null()) },
  returns: v.any(),
  handler: async (ctx, { groupId }) => {
    const rows = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "systemAgreements")).take(5000);
    const selected = rows.filter(row => groupId === null || Number((row.data as { groupId?: number }).groupId) === groupId).slice(-500).reverse();
    const agreements = [];
    for (const row of selected) {
      const agreement = row.data as Record<string, unknown>;
      const group = typeof agreement.groupId === "number"
        ? await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups").eq("legacyId", Number(agreement.groupId))).unique()
        : null;
      agreements.push({ agreementCode: agreement.agreementCode, groupId: agreement.groupId, groupName: (group?.data as { name?: string } | undefined)?.name || "Deleted group", status: agreement.status, createdAt: agreement.createdAt, expiresAt: agreement.expiresAt, signedAt: agreement.signedAt, version: agreement.version });
    }
    return { agreements };
  },
});

export const memberOverview = internalQuery({
  args: { userId: v.number() },
  returns: v.any(),
  handler: async (ctx, { userId }) => {
    const userRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId))
      .unique();
    if (!userRow) return null;
    const user = userRow.data as Record<string, unknown>;
    const groupId = typeof user.groupId === "number" ? user.groupId : null;
    const groupRow = groupId !== null
      ? await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups").eq("legacyId", groupId)).unique()
      : null;
    const groupData = groupRow?.data as Record<string, unknown> | undefined;
    const profiles = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", userId))
      .take(10);
    const fees = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "registrationFees").eq("userId", userId))
      .take(1000);
    const savings = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "savings").eq("userId", userId))
      .take(5000);
    const notifications = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "notifications").eq("userId", userId))
      .take(1000);
    const role = String(user.role || "member");
    const visible = notifications.filter((row) => {
      const n = row.data as Record<string, unknown>;
      const recipient = n.recipientId ?? n.userId;
      if (recipient != null) return Number(recipient) === userId && (!n.recipientRole || n.recipientRole === role) &&
        (role !== "group_admin" || n.groupId == null || Number(n.groupId) === Number(user.groupId));
      return n.recipientRole === role && !["v_super_admin", "super_admin"].includes(role) &&
        (n.groupId == null || Number(n.groupId) === Number(user.groupId));
    });
    const savingsTotalCents = savings.reduce((sum, row) => {
      const item = row.data as { amountCents?: number; reversed?: boolean; status?: string };
      return sum + (!item.reversed && (!item.status || item.status === "verified") ? Number(item.amountCents || 0) : 0);
    }, 0);
    const safeUser = {
      id: user.id, firstName: user.firstName, lastName: user.lastName,
      name: `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim(),
      email: user.email, phone: user.phone, role: user.role, groupId: user.groupId || null,
      pic: user.pic || null, locked: Boolean(user.locked), disabled: Boolean(user.disabled),
      passwordChangeRequired: Boolean(user.passwordChangeRequired), failed: Number(user.failed || 0),
      createdAt: user.createdAt, pub: user.ecdhPub || null,
    };
    return {
      me: safeUser,
      group: groupData ? { id: groupData.id, name: groupData.name, description: groupData.description } : null,
      unread: visible.filter((row) => { const n = row.data as { readAt?: unknown; read?: unknown }; return !n.readAt && !n.read; }).length,
      memberProfile: (profiles[0]?.data as unknown) || null,
      registrationFeePending: fees.some((row) => { const fee = row.data as { status?: string; reversed?: boolean }; return fee.status === "pending" && !fee.reversed; }),
      savingsTotalCents,
    };
  },
});

export const memberPanel = internalQuery({
  args: { userId: v.number(), view: v.union(v.literal("overview"), v.literal("items"), v.literal("loans")) },
  returns: v.any(),
  handler: async (ctx, { userId, view }) => {
    const userRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId))
      .unique();
    if (!userRow) return { status: 401, error: "Authentication required" };
    const user = userRow.data as Record<string, unknown>;
    if (!["member", "admin", "super_admin", "group_admin"].includes(String(user.role))) return { status: 403, error: "Forbidden: insufficient role" };
    const groupId = typeof user.groupId === "number" ? user.groupId : null;
    if (view === "items") {
      const rows = groupId === null ? [] : await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_group_id", (q) => q.eq("collection", "items").eq("groupId", groupId))
        .take(1000);
      return { status: 200, items: rows.map((row) => row.data).filter((item) => (item as { active?: boolean }).active !== false) };
    }
    if (view === "loans") {
      const [cashRows, itemRows] = await Promise.all([
        ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "cashLoans").eq("userId", userId)).take(1000),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "itemLoans").eq("userId", userId)).take(1000),
      ]);
      const now = Date.now();
      const unsortedLoans: Record<string, unknown>[] = [
        ...cashRows.map((row) => {
          const loan = row.data as Record<string, unknown>;
          const dueAt = Date.parse(String(loan.dueAt || ""));
          const fineNowCents = ["disbursed", "overdue"].includes(String(loan.status)) && Number.isFinite(dueAt) && now > dueAt
            ? Math.round(Number(loan.amountCents || 0) * 0.01) : 0;
          return { ...loan, type: "cash", fineNowCents };
        }),
        ...itemRows.map((row) => ({ ...(row.data as Record<string, unknown>), type: "item" })),
      ];
      const loans = unsortedLoans.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
      return { status: 200, loans };
    }

    const groupRow = groupId === null ? null : await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups").eq("legacyId", groupId)).unique();
    const group = groupRow?.data as Record<string, unknown> | undefined;
    const allUsers = groupId === null ? [] : await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_group_id", (q) => q.eq("collection", "users").eq("groupId", groupId)).take(300);
    const groupAdmin = allUsers.map((row) => row.data as Record<string, unknown>)
      .find((entry) => entry.role === "group_admin" && !entry.deleted);
    const [messageRows, notificationRows, savingsRows, cashRows, itemLoanRows, items] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "messages")).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "notifications")).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "savings").eq("userId", userId)).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "cashLoans").eq("userId", userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "itemLoans").eq("userId", userId)).take(1000),
      groupId === null ? Promise.resolve([]) : ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "items").eq("groupId", groupId)).take(1000),
    ]);
    const messages = messageRows.filter((row) => {
      const item = row.data as { senderId?: number; recipientId?: number };
      return item.senderId === userId || item.recipientId === userId;
    }).length;
    const announcements = notificationRows.filter((row) => {
      const item = row.data as Record<string, unknown>;
      return item.type === "announcement" && (item.userId == null || Number(item.userId) === userId) &&
        (item.groupId == null || Number(item.groupId) === groupId);
    }).length;
    const savingsTotalCents = savingsRows.reduce((sum, row) => {
      const entry = row.data as { amountCents?: number; reversed?: boolean; status?: string };
      return sum + (!entry.reversed && (!entry.status || entry.status === "verified") ? Number(entry.amountCents || 0) : 0);
    }, 0);
    const activeLoans = [...cashRows, ...itemLoanRows].filter((row) => ["disbursed", "overdue"].includes(String((row.data as { status?: string }).status))).length;
    const kit = ["cap", "tshirt"].map((category) => ({
      category,
      items: items.map((row) => row.data as Record<string, unknown>)
        .filter((item) => item.category === category && item.active !== false)
        .map((item) => {
          const loan = itemLoanRows.map((row) => row.data as Record<string, unknown>)
            .find((entry) => entry.itemId === item.id && entry.status !== "rejected");
          return { itemId: item.id, name: item.name, description: item.description, priceCents: item.priceCents, status: loan ? loan.status : "available" };
        }),
    }));
    return {
      status: 200,
      me: {
        id: user.id, firstName: user.firstName, lastName: user.lastName,
        name: `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim(),
        email: user.email, phone: user.phone, role: user.role, groupId: groupId,
        pic: user.pic || null, locked: Boolean(user.locked), disabled: Boolean(user.disabled),
        passwordChangeRequired: Boolean(user.passwordChangeRequired), failed: Number(user.failed || 0),
        createdAt: user.createdAt, pub: user.ecdhPub || null,
      },
      group: group || null,
      groupAdmin: groupAdmin ? { id: groupAdmin.id, name: `${String(groupAdmin.firstName || "")} ${String(groupAdmin.lastName || "")}`.trim(), email: groupAdmin.email, phone: groupAdmin.phone, pic: groupAdmin.pic } : null,
      stats: { messages, announcements, joined: user.createdAt, activeLoans, savingsTotalCents },
      kit,
    };
  },
});

export const memberLoanPage = internalQuery({
  args: { userId: v.number(), page: v.number(), status: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const profiles = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", args.userId)).take(5);
    if (!profiles.length) return { status: 404, error: "Member profile not found" };
    const [cash, items, fineRows] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "cashLoans").eq("userId", args.userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "itemLoans").eq("userId", args.userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "fines").eq("userId", args.userId)).take(1000),
    ]);
    const fines = fineRows.map((row) => row.data as Record<string, unknown>).filter((fine) => !fine.reversed);
    let loans: Record<string, unknown>[] = [...cash, ...items].map((row) => row.data as Record<string, unknown>);
    if (args.status) loans = loans.filter((loan) => loan.status === args.status);
    loans.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    const total = loans.length;
    const safePage = Math.max(1, Math.floor(args.page) || 1);
    const pageLoans = loans.slice((safePage - 1) * 10, safePage * 10).map((loan) => {
      const relatedFines = fines.filter((fine) => fine.loanId === loan.id);
      const dueAt = Date.parse(String(loan.dueAt || ""));
      const fineNowCents = loan.type === "cash" && ["disbursed", "overdue"].includes(String(loan.status)) && Number.isFinite(dueAt) && Date.now() > dueAt &&
        !fines.some((fine) => fine.loanId === loan.id) ? Math.round(Number(loan.amountCents || 0) * 0.01) : 0;
      return {
        id: loan.id, type: loan.type, itemId: loan.itemId, itemName: loan.itemName,
        amountCents: loan.amountCents, totalDueCents: loan.totalDueCents, profitCents: loan.profitCents,
        costCents: loan.costCents, week: loan.week, status: loan.status, dueAt: loan.dueAt,
        verifiedAt: loan.verifiedAt, verifiedBy: loan.verifiedBy ? { role: "staff" } : null,
        disbursedAt: loan.disbursedAt, clearedAt: loan.clearedAt, clearedBy: loan.clearedBy ? { role: "staff" } : null,
        fineCents: loan.fineCents, fineNowCents, staffLoan: Boolean(loan.staffLoan),
        requiresPaymentReport: Boolean(loan.requiresPaymentReport), repaymentReportedAt: loan.repaymentReportedAt || null,
        createdAt: loan.createdAt, updatedAt: loan.updatedAt,
        fines: relatedFines.map((fine) => ({ id: fine.id, amountCents: fine.amountCents, paid: Boolean(fine.paid), paidAt: fine.paidAt, createdAt: fine.createdAt })),
      };
    });
    return { status: 200, loans: pageLoans, page: safePage, total, pages: Math.max(1, Math.ceil(total / 10)) };
  },
});

export const memberLoanDetail = internalQuery({
  args: { userId: v.number(), loanId: v.number() },
  returns: v.any(),
  handler: async (ctx, { userId, loanId }) => {
    const [cashRow, itemRow] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "cashLoans").eq("legacyId", loanId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "itemLoans").eq("legacyId", loanId)).unique(),
    ]);
    const row = cashRow?.data && Number((cashRow.data as { userId?: number }).userId) === userId ? cashRow
      : itemRow?.data && Number((itemRow.data as { userId?: number }).userId) === userId ? itemRow : null;
    if (!row) return { status: 404, error: "Loan not found" };
    const loan = row.data as Record<string, unknown>;
    const [fines, verifier, clearer] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "fines").eq("userId", userId)).take(1000),
      typeof loan.verifiedBy === "number" ? ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", loan.verifiedBy as number)).unique() : Promise.resolve(null),
      typeof loan.clearedBy === "number" ? ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", loan.clearedBy as number)).unique() : Promise.resolve(null),
    ]);
    const relatedFines = fines.map((entry) => entry.data as Record<string, unknown>).filter((fine) => fine.loanId === loan.id && !fine.reversed);
    const dueAt = Date.parse(String(loan.dueAt || ""));
    const fineNowCents = loan.type === "cash" && ["disbursed", "overdue"].includes(String(loan.status)) && Number.isFinite(dueAt) && Date.now() > dueAt && !relatedFines.length
      ? Math.round(Number(loan.amountCents || 0) * 0.01) : 0;
    return {
      status: 200,
      loan: {
        id: loan.id, type: loan.type, itemId: loan.itemId, itemName: loan.itemName,
        amountCents: loan.amountCents, totalDueCents: loan.totalDueCents, profitCents: loan.profitCents,
        costCents: loan.costCents, week: loan.week, status: loan.status, dueAt: loan.dueAt,
        verifiedAt: loan.verifiedAt, verifiedBy: verifier ? { role: (verifier.data as { role?: string }).role } : null,
        disbursedAt: loan.disbursedAt, clearedAt: loan.clearedAt, clearedBy: clearer ? { role: (clearer.data as { role?: string }).role } : null,
        fineCents: loan.fineCents, fineNowCents, staffLoan: Boolean(loan.staffLoan),
        requiresPaymentReport: Boolean(loan.requiresPaymentReport), repaymentReportedAt: loan.repaymentReportedAt || null,
        createdAt: loan.createdAt, updatedAt: loan.updatedAt,
        fines: relatedFines.map((fine) => ({ id: fine.id, amountCents: fine.amountCents, paid: Boolean(fine.paid), paidAt: fine.paidAt, createdAt: fine.createdAt })),
      },
    };
  },
});

export const requestMemberLoan = internalMutation({
  args: {
    userId: v.number(), type: v.union(v.literal("cash"), v.literal("item")), amountCents: v.number(),
    itemId: v.union(v.number(), v.null()), idempotencyKey: v.string(), now: v.string(), week: v.string(),
  },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), loan: v.any() }),
  handler: async (ctx, args) => {
    const userRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.userId)).unique();
    const user = userRow?.data as Record<string, unknown> | undefined;
    if (!user || user.deleted || user.disabled || typeof user.groupId !== "number") return { status: 403, error: "You are not assigned to a group", loan: null };
    if (!["member", "admin", "super_admin", "group_admin"].includes(String(user.role))) return { status: 403, error: "Forbidden: insufficient role", loan: null };
    const groupId = user.groupId;
    const groupRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups").eq("legacyId", groupId)).unique();
    if ((groupRow?.data as { suspended?: boolean } | undefined)?.suspended) return { status: 423, error: "This group is suspended. Contact the system Owner.", loan: null };
    const profileRows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", args.userId)).take(5);
    const profile = profileRows[0]?.data as { registrationFeePaid?: boolean; agreementSigned?: boolean } | undefined;
    if (!profile) return { status: 400, error: "Member profile not found", loan: null };
    if (!profile.registrationFeePaid) return { status: 400, error: "Pay the KES 200 registration fee first", loan: null };
    if (user.role !== "admin" && user.role !== "super_admin" && user.role !== "group_admin" && !profile.agreementSigned) {
      return { status: 400, error: "Sign the Kenya Chama Agreement first", loan: null };
    }
    const [cashRows, itemLoanRows, savingsRows] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "cashLoans").eq("userId", args.userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "itemLoans").eq("userId", args.userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "savings").eq("userId", args.userId)).take(5000),
    ]);
    if (cashRows.some((row) => !["cleared", "rejected"].includes(String((row.data as { status?: string }).status)))) {
      return { status: 400, error: "You have an uncleared loan. Clear it before borrowing again.", loan: null };
    }
    const loans = [...cashRows, ...itemLoanRows].map((row) => row.data as Record<string, unknown>);
    if (loans.some((loan) => loan.week === args.week && loan.type === args.type && loan.status !== "rejected")) {
      return { status: 400, error: `Only one ${args.type} loan is allowed per week`, loan: null };
    }
    if (args.type === "item" && itemLoanRows.some((row) => {
      const loan = row.data as { itemId?: number; status?: string };
      return loan.itemId === args.itemId && !["cleared", "rejected"].includes(String(loan.status));
    })) return { status: 409, error: "You already have an outstanding loan for this item", loan: null };

    const savingsCents = savingsRows.reduce((sum, row) => {
      const saving = row.data as { amountCents?: number; reversed?: boolean; status?: string };
      return sum + (!saving.reversed && (!saving.status || saving.status === "verified") ? Number(saving.amountCents || 0) : 0);
    }, 0);
    let item: Record<string, unknown> | null = null;
    if (args.type === "item") {
      if (args.itemId === null) return { status: 400, error: "Choose an available group item", loan: null };
      const itemRow = await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "items").eq("legacyId", args.itemId!)).unique();
      item = itemRow?.data as Record<string, unknown> | undefined || null;
      if (!item || item.groupId !== groupId || item.active === false) return { status: 400, error: "Choose an available group item", loan: null };
      if (!Number.isSafeInteger(item.priceCents) || Number(item.priceCents) <= 0) return { status: 400, error: "This item needs a valid price set by the Group Admin", loan: null };
    } else {
      if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0 || args.amountCents > 100000000) return { status: 400, error: "Enter a valid cash amount", loan: null };
      if (args.amountCents > Math.floor(savingsCents * 0.5)) return { status: 400, error: `Loan amount cannot exceed 50% of your savings (KES ${(Math.floor(savingsCents * 0.5) / 100).toFixed(2)})`, loan: null };
    }
    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const counterName = args.type === "cash" ? "cashLoan" : "itemLoan";
    const id = Number(counters[counterName] || 0) + 1;
    const amountCents = args.type === "cash" ? args.amountCents : 0;
    const costCents = args.type === "item" ? Number(item?.priceCents || 0) : 0;
    const loan = {
      id, userId: args.userId, groupId, type: args.type, itemId: args.itemId,
      itemName: String(item?.name || ""), itemDescription: "", amountCents,
      totalDueCents: args.type === "cash" ? amountCents : 0, profitCents: 0, costCents,
      week: args.week, status: "pending", dueAt: null, verifiedAt: null, verifiedBy: null,
      disbursedAt: null, clearedAt: null, clearedBy: null, fineCents: 0,
      idempotencyKey: args.idempotencyKey, staffLoan: ["admin", "super_admin", "group_admin"].includes(String(user.role)),
      requiresPaymentReport: true, repaymentReportedAt: null, repaymentReportedBy: null,
      repaymentReportedCents: null, createdAt: args.now, updatedAt: args.now,
    };
    await ctx.db.insert("legacyRecords", { collection: args.type === "cash" ? "cashLoans" : "itemLoans", legacyId: id, userId: args.userId, groupId, status: "pending", data: loan });
    counters[counterName] = id;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 201, error: null, loan };
  },
});

export const reportLoanRepayment = internalMutation({
  args: { userId: v.number(), loanId: v.number(), now: v.string(), nowMs: v.number() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), repaymentReportedAt: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const [cash, item] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "cashLoans").eq("legacyId", args.loanId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "itemLoans").eq("legacyId", args.loanId)).unique(),
    ]);
    const row = cash?.data && Number((cash.data as { userId?: number }).userId) === args.userId ? cash
      : item?.data && Number((item.data as { userId?: number }).userId) === args.userId ? item : null;
    if (!row) return { status: 404, error: "Loan not found", repaymentReportedAt: null };
    const loan = row.data as Record<string, unknown>;
    if (!["disbursed", "overdue"].includes(String(loan.status))) return { status: 400, error: "Only an active loan can be reported as repaid", repaymentReportedAt: null };
    if (loan.repaymentReportedAt) return { status: 409, error: "Repayment is already awaiting Group Admin verification", repaymentReportedAt: null };
    const fineRows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "fines").eq("userId", args.userId)).take(1000);
    const fineRecords = fineRows.map((entry) => entry.data as Record<string, unknown>);
    let fineCents = 0;
    const dueAt = Date.parse(String(loan.dueAt || ""));
    if (loan.type === "cash" && Number.isFinite(dueAt) && args.nowMs > dueAt && !fineRecords.some((fine) => fine.loanId === args.loanId && !fine.reversed)) {
      fineCents = Math.round(Number(loan.amountCents || 0) * 0.01);
    }
    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    if (fineCents > 0) {
      const fineId = Number(counters.fine || 0) + 1;
      const fine = {
        id: fineId, userId: args.userId, groupId: loan.groupId, loanId: args.loanId,
        amountCents: fineCents, paid: false, paidAt: null,
        idempotencyKey: `fine:loan:${args.loanId}`, reversed: false, reversalOf: null, createdAt: args.now,
      };
      await ctx.db.insert("legacyRecords", { collection: "fines", legacyId: fineId, userId: args.userId, ...(typeof loan.groupId === "number" ? { groupId: loan.groupId } : {}), data: fine });
      counters.fine = fineId;
      fineRecords.push(fine);
    }
    const outstanding = fineRecords.filter((fine) => fine.loanId === args.loanId && !fine.reversed && !fine.paid)
      .reduce((sum, fine) => sum + Number(fine.amountCents || 0), 0);
    const repaymentReportedAt = args.now;
    const updated = {
      ...loan,
      fineCents: Number(loan.fineCents || 0) + fineCents,
      repaymentReportedAt, repaymentReportedBy: args.userId,
      repaymentReportedCents: Number(loan.totalDueCents || loan.costCents || loan.amountCents || 0) + outstanding,
      updatedAt: args.now,
    };
    await ctx.db.patch(row._id, { data: updated });
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 200, error: null, repaymentReportedAt };
  },
});

export const reportMemberFinance = internalMutation({
  args: {
    userId: v.number(), kind: v.union(v.literal("registrationFee"), v.literal("saving")),
    amountCents: v.number(), description: v.string(), idempotencyKey: v.string(), week: v.string(), now: v.string(),
  },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), record: v.any(), pendingVerification: v.boolean() }),
  handler: async (ctx, args) => {
    const userRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.userId)).unique();
    const user = userRow?.data as Record<string, unknown> | undefined;
    if (!user || user.deleted || user.disabled) return { status: 401, error: "Authentication required", record: null, pendingVerification: false };
    const profiles = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", args.userId)).take(5);
    const profileRow = profiles[0];
    const profile = profileRow?.data as Record<string, unknown> | undefined;
    if (!profile) return { status: 404, error: "Member profile not found", record: null, pendingVerification: false };
    const staff = ["super_admin", "admin", "group_admin"].includes(String(user.role));
    const collection = args.kind === "registrationFee" ? "registrationFees" : "savings";
    const existingRows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", collection).eq("userId", args.userId)).take(1000);
    if (args.kind === "registrationFee") {
      if (profile.registrationFeePaid) return { status: 400, error: "Registration fee already paid", record: null, pendingVerification: false };
      const pending = existingRows.find((row) => { const item = row.data as { status?: string; reversed?: boolean }; return item.status === "pending" && !item.reversed; });
      if (pending) return { status: 200, error: null, record: pending.data, pendingVerification: true };
    } else {
      if (!profile.registrationFeePaid) return { status: 400, error: "Pay registration fee first", record: null, pendingVerification: false };
      if (!staff && !profile.agreementSigned) return { status: 400, error: "Sign the current system agreement first", record: null, pendingVerification: false };
      if (!Number.isSafeInteger(args.amountCents) || args.amountCents <= 0) return { status: 400, error: "Enter a valid amount", record: null, pendingVerification: false };
      if (existingRows.some((row) => { const item = row.data as { week?: string; reversed?: boolean }; return item.week === args.week && !item.reversed; })) {
        return { status: 409, error: "A saving has already been recorded for this week", record: null, pendingVerification: false };
      }
    }
    const repeated = existingRows.find((row) => (row.data as { idempotencyKey?: string }).idempotencyKey === args.idempotencyKey);
    if (repeated) return { status: 200, error: null, record: repeated.data, pendingVerification: true };

    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const counter = args.kind === "registrationFee" ? "registrationFee" : "saving";
    const id = Number(counters[counter] || 0) + 1;
    const amountCents = args.kind === "registrationFee" ? 20000 : args.amountCents;
    const record: Record<string, unknown> = {
      id, userId: args.userId, groupId: profile.groupId ?? null, amountCents,
      idempotencyKey: args.idempotencyKey, reversed: false, reversalOf: null,
      createdAt: args.now, status: "pending", reportedAt: args.now, reportedBy: args.userId,
      staffRequest: staff, submittedRole: user.role,
    };
    if (args.kind === "registrationFee") record.week = "";
    else { record.week = args.week; record.description = args.description || "Weekly saving"; }
    await ctx.db.insert("legacyRecords", {
      collection, legacyId: id, userId: args.userId,
      ...(typeof profile.groupId === "number" ? { groupId: profile.groupId } : {}),
      status: "pending", data: record,
    });
    counters[counter] = id;
    const targets = staff
      ? (await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users")).take(300))
          .map((row) => row.data as Record<string, unknown>)
          .filter((recipient) => recipient.role === "v_super_admin" && !recipient.deleted && !recipient.disabled)
      : typeof profile.groupId === "number"
        ? (await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "users").eq("groupId", Number(profile.groupId))).take(300))
            .map((row) => row.data as Record<string, unknown>)
            .filter((recipient) => recipient.role === "group_admin" && !recipient.deleted && !recipient.disabled)
        : [];
    for (const recipient of targets) {
      const notificationId = Number(counters.notification || 0) + 1;
      const fullName = `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim();
      const title = args.kind === "registrationFee"
        ? staff ? "Staff registration fee awaiting Owner approval" : "Registration fee needs verification"
        : staff ? "Staff savings contribution awaiting Owner approval" : "Savings contribution needs verification";
      const body = args.kind === "registrationFee"
        ? `${fullName} reported payment of KES 200. Review it in Financial Verifications.`
        : `${fullName} reported KES ${(amountCents / 100).toFixed(2)} for ${args.week}. Review it in Financial Verifications.`;
      const recipientId = Number(recipient.id);
      await ctx.db.insert("legacyRecords", {
        collection: "notifications", legacyId: notificationId, userId: recipientId,
        ...(typeof recipient.groupId === "number" ? { groupId: recipient.groupId } : {}),
        data: {
          id: notificationId, userId: recipientId, recipientId, recipientRole: recipient.role,
          groupId: recipient.groupId ?? null, senderId: args.userId, senderRole: user.role,
          type: args.kind === "registrationFee" ? "registration_fee" : "saving",
          title, body, read: false, readAt: null, createdAt: args.now, at: args.now,
        },
      });
      counters.notification = notificationId;
    }
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: args.kind === "saving" ? 201 : 200, error: null, record, pendingVerification: true };
  },
});

export const memberLedger = internalQuery({
  args: { userId: v.number(), collection: v.union(v.literal("savings"), v.literal("fines")) },
  returns: v.any(),
  handler: async (ctx, { userId, collection }) => {
    const profiles = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", userId)).take(5);
    if (!profiles.length) return { status: 404, error: "Member profile not found" };
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", collection).eq("userId", userId)).take(5000);
    const records = rows.map((row) => row.data as Record<string, unknown>).filter((item) => !item.reversed).reverse();
    if (collection === "savings") {
      const totalCents = records.reduce((sum, item) => sum + (!item.status || item.status === "verified" ? Number(item.amountCents || 0) : 0), 0);
      const pendingCents = records.reduce((sum, item) => sum + (item.status === "pending" ? Number(item.amountCents || 0) : 0), 0);
      return { status: 200, savings: records, totalCents, pendingCents };
    }
    return { status: 200, fines: records, totalCents: records.reduce((sum, item) => sum + Number(item.amountCents || 0), 0) };
  },
});

export const memberFinePage = internalQuery({
  args: { userId: v.number(), page: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const profiles = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", q => q.eq("collection", "memberProfiles").eq("userId", args.userId)).take(5);
    if (!profiles.length) return { status: 404, error: "Member profile not found" };
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", q => q.eq("collection", "fines").eq("userId", args.userId)).take(5000);
    const fines = rows.map(row => row.data as Record<string, unknown>)
      .filter(fine => !fine.reversed).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    const page = Math.max(1, Math.floor(args.page) || 1);
    const total = fines.length;
    const totalCents = fines.reduce((sum, fine) => sum + Number(fine.amountCents || 0), 0);
    const paidCents = fines.filter(fine => fine.paid).reduce((sum, fine) => sum + Number(fine.amountCents || 0), 0);
    const selected = fines.slice((page - 1) * 10, page * 10);
    const pageFines = [];
    for (const fine of selected) {
      const loanId = Number(fine.loanId || 0);
      const cash = loanId ? await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "cashLoans").eq("legacyId", loanId)).unique() : null;
      const item = !cash && loanId ? await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "itemLoans").eq("legacyId", loanId)).unique() : null;
      const loan = (cash?.data || item?.data) as { id?: number; type?: string } | undefined;
      pageFines.push({
        id: fine.id, loanId: fine.loanId, amountCents: fine.amountCents, paid: Boolean(fine.paid),
        paidAt: fine.paidAt || null, createdAt: fine.createdAt, reversed: Boolean(fine.reversed),
        reversalOf: fine.reversalOf || null, loanRef: loan ? `#${String(loan.id || fine.loanId)}` : "-",
        loanType: loan?.type || (cash ? "cash" : item ? "item" : "-"),
      });
    }
    return { status: 200, fines: pageFines, page, total, pages: Math.max(1, Math.ceil(total / 10)), totalCents, paidCents, outstandingCents: totalCents - paidCents };
  },
});

export const memberFinanceTrend = internalQuery({
  args: { userId: v.number(), now: v.string() },
  returns: v.any(),
  handler: async (ctx, { userId, now }) => {
    const [savingsRows, cashRows, itemRows] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "savings").eq("userId", userId)).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "cashLoans").eq("userId", userId)).take(2000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", q => q.eq("collection", "itemLoans").eq("userId", userId)).take(2000),
    ]);
    const current = new Date(now);
    const currentTime = current.getTime();
    const firstMonth = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 11, 1);
    const periods = Array.from({ length: 12 }, (_, index) => {
      const start = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - 11 + index, 1));
      return { end: Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1) - 1, label: new Intl.DateTimeFormat("en-KE", { month: "short", year: "2-digit", timeZone: "UTC" }).format(start) };
    });
    const savings = savingsRows.map(row => row.data as Record<string, unknown>);
    const loans: Record<string, unknown>[] = [...cashRows.map(row => ({ ...(row.data as Record<string, unknown>), type: "cash" })), ...itemRows.map(row => ({ ...(row.data as Record<string, unknown>), type: "item" }))];
    const events: { at: number; savings: number; loans: number }[] = [];
    for (const entry of savings) {
      if (entry.reversed || (entry.status && entry.status !== "verified")) continue;
      const at = Date.parse(String(entry.verifiedAt || entry.createdAt || ""));
      if (Number.isFinite(at) && at <= currentTime) events.push({ at, savings: Number(entry.amountCents || 0), loans: 0 });
    }
    for (const loan of loans) {
      const amount = Number(loan.type === "item" ? loan.costCents || loan.amountCents : loan.amountCents || loan.totalDueCents) || 0;
      const active = ["disbursed", "overdue"].includes(String(loan.status));
      const disbursedAt = Date.parse(String(loan.disbursedAt || (active || loan.status === "cleared" ? loan.verifiedAt || loan.createdAt : "") || ""));
      if (amount > 0 && Number.isFinite(disbursedAt) && disbursedAt <= currentTime) events.push({ at: disbursedAt, savings: 0, loans: amount });
      const clearedAt = Date.parse(String(loan.clearedAt || loan.repaidAt || ""));
      if (amount > 0 && Number.isFinite(clearedAt) && clearedAt <= currentTime) events.push({ at: clearedAt, savings: 0, loans: -amount });
    }
    events.sort((a, b) => a.at - b.at);
    let savingsCents = 0, loanOutstandingCents = 0, eventIndex = 0;
    const savingsSeries: number[] = [], loanBalance: number[] = [];
    for (const period of periods) {
      while (eventIndex < events.length && events[eventIndex].at <= period.end) {
        savingsCents += events[eventIndex].savings;
        loanOutstandingCents += events[eventIndex].loans;
        eventIndex++;
      }
      savingsSeries.push(Math.max(0, savingsCents));
      loanBalance.push(Math.max(0, loanOutstandingCents));
    }
    const pendingSavingsCents = savings.filter(entry => !entry.reversed && entry.status === "pending").reduce((sum, entry) => sum + Number(entry.amountCents || 0), 0);
    const activeLoans = loans.filter(loan => ["disbursed", "overdue"].includes(String(loan.status)));
    const activeLoanCents = activeLoans.reduce((sum, loan) => sum + Number(loan.type === "item" ? loan.costCents || loan.amountCents : loan.amountCents || loan.totalDueCents) || 0, 0);
    const verifiedSavingsCents = savings.filter(entry => !entry.reversed && (!entry.status || entry.status === "verified")).reduce((sum, entry) => sum + Number(entry.amountCents || 0), 0);
    return {
      labels: periods.map(period => period.label),
      series: { savingsCents: savingsSeries, loanOutstandingCents: loanBalance },
      summary: { members: 1, verifiedSavingsCents, pendingSavingsCents, activeLoanCents, activeLoans: activeLoans.length },
      periodStart: new Date(firstMonth).toISOString(), updatedAt: current.toISOString(),
    };
  },
});

export const memberStatement = internalQuery({
  args: { userId: v.number() },
  returns: v.any(),
  handler: async (ctx, { userId }) => {
    const userRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId)).unique();
    if (!userRow) return { status: 401, error: "Authentication required" };
    const profile = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", userId)).take(5);
    if (!profile.length) return { status: 404, error: "Member profile not found" };
    const [savings, cashLoans, itemLoans, fines, branding] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "savings").eq("userId", userId)).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "cashLoans").eq("userId", userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "itemLoans").eq("userId", userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_user_id", (q) => q.eq("collection", "fines").eq("userId", userId)).take(1000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "branding")).order("desc").take(100),
    ]);
    const user = userRow.data as Record<string, unknown>;
    const activeBranding = branding.map((row) => row.data as { name?: string; rolledBack?: boolean }).find((entry) => !entry.rolledBack);
    const activeSavings = savings.map((row) => row.data as Record<string, unknown>).filter((entry) => !entry.reversed).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    const loans = [...cashLoans, ...itemLoans].map((row) => row.data as Record<string, unknown>).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    const activeFines = fines.map((row) => row.data as Record<string, unknown>).filter((entry) => !entry.reversed).sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
    return {
      status: 200, user: {
        id: user.id, firstName: user.firstName, lastName: user.lastName,
        email: user.email, phone: user.phone, role: user.role,
      }, brandName: activeBranding?.name || "VonDonald051 Savings",
      savings: activeSavings, loans, fines: activeFines,
    };
  },
});

export const groupAdminPanel = internalQuery({
  args: { userId: v.number(), view: v.union(
    v.literal("overview"), v.literal("members"), v.literal("registrationFees"), v.literal("savings"),
    v.literal("loans"), v.literal("items"), v.literal("safeCodes"), v.literal("requests"),
  ) },
  returns: v.any(),
  handler: async (ctx, { userId, view }) => {
    const adminRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId)).unique();
    const admin = adminRow?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin") return { status: 403, error: "Forbidden: insufficient role" };
    const groupId = typeof admin.groupId === "number" ? admin.groupId : null;
    if (groupId === null) return { status: 400, error: "You are not assigned to a group" };
    const groupRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups").eq("legacyId", groupId)).unique();
    const group = groupRow?.data || null;

    if (["members", "overview", "loans"].includes(view)) {
      const [users, cashLoans, itemLoans, savings] = await Promise.all([
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "users").eq("groupId", groupId)).take(300),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "cashLoans").eq("groupId", groupId)).take(1000),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "itemLoans").eq("groupId", groupId)).take(1000),
        ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "savings").eq("groupId", groupId)).take(5000),
      ]);
      const groupUsers = users.map((row) => row.data as Record<string, unknown>).filter((entry) => !entry.deleted);
      const memberUsers = groupUsers.filter((entry) => entry.role === "member");
      if (view === "members") {
        const profiles = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "agreements").eq("groupId", groupId)).take(1000);
        const activeSavings = savings.map((row) => row.data as Record<string, unknown>).filter((entry) => !entry.reversed && (!entry.status || entry.status === "verified"));
        const maskEmail = (value: unknown) => { const [name, domain] = String(value || "").split("@"); return domain ? `${name.slice(0, 1)}${"*".repeat(Math.min(Math.max(name.length - 1, 2), 8))}@${domain}` : ""; };
        const maskPhone = (value: unknown) => { const phone = String(value || ""); return phone.length <= 6 ? `${phone.slice(0, 1)}#####` : `${phone.slice(0, 4)}####${phone.slice(-2)}`; };
        return { status: 200, members: memberUsers.map((entry) => {
          const agreement = profiles.map((row) => row.data as Record<string, unknown>).find((item) => item.userId === entry.id && !item.rolledBack);
          return {
            id: entry.id, firstName: entry.firstName, lastName: entry.lastName,
            name: `${String(entry.firstName || "")} ${String(entry.lastName || "")}`.trim(),
            email: maskEmail(entry.email), phone: maskPhone(entry.phone), role: entry.role,
            groupId: entry.groupId, pic: entry.pic || null, locked: Boolean(entry.locked), disabled: Boolean(entry.disabled),
            passwordChangeRequired: Boolean(entry.passwordChangeRequired), failed: Number(entry.failed || 0), createdAt: entry.createdAt,
            pub: entry.ecdhPub || null,
            savingsCents: activeSavings.filter((saving) => saving.userId === entry.id).reduce((sum, saving) => sum + Number(saving.amountCents || 0), 0),
            agreementSigned: Boolean(agreement), agreementApproved: Boolean(agreement?.groupAdminSignedAt),
          };
        }) };
      }
      if (view === "loans") {
        const staffIds = new Set(groupUsers.filter((entry) => ["super_admin", "admin", "group_admin"].includes(String(entry.role))).map((entry) => Number(entry.id)));
        const safe = (row: { data: unknown }, type: string) => {
          const loan = row.data as Record<string, unknown>;
          const dueAt = Date.parse(String(loan.dueAt || ""));
          return {
            id: loan.id, type, groupId: loan.groupId, amountCents: loan.amountCents, totalDueCents: loan.totalDueCents,
            itemName: loan.itemName, dueAt: loan.dueAt, fineCents: loan.fineCents,
            fineNowCents: type === "cash" && ["disbursed", "overdue"].includes(String(loan.status)) && Number.isFinite(dueAt) && Date.now() > dueAt ? Math.round(Number(loan.amountCents || 0) * 0.01) : 0,
            status: loan.status, createdAt: loan.createdAt, verifiedAt: loan.verifiedAt, disbursedAt: loan.disbursedAt, repaidAt: loan.repaidAt,
          };
        };
        const loans = [
          ...cashLoans.filter((row) => !staffIds.has(Number((row.data as { userId?: number }).userId))).map((row) => safe(row, "cash")),
          ...itemLoans.filter((row) => !staffIds.has(Number((row.data as { userId?: number }).userId))).map((row) => safe(row, "item")),
        ].sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
        return { status: 200, loans };
      }
      if (view === "overview") {
        const [codes, requests, messages] = await Promise.all([
          ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "safeCodes").eq("groupId", groupId)).take(1000),
          ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", "requests").eq("groupId", groupId)).take(1000),
          ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "messages")).take(1000),
        ]);
        const codeData = codes.map((row) => row.data as { active?: boolean; usedBy?: number | null });
        const loanData = [...cashLoans, ...itemLoans].map((row) => row.data as { status?: string });
        const activeSavings = savings.map((row) => row.data as { userId?: number; amountCents?: number; reversed?: boolean; status?: string })
          .filter((entry) => !entry.reversed && (!entry.status || entry.status === "verified"));
        const safeCodeSettings = await ctx.db.query("legacyRecords")
          .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
        const settings = (safeCodeSettings?.data as { settings?: { safe_code_required?: string } } | undefined)?.settings;
        return {
          status: 200, group,
          members: groupUsers.filter((entry) => ["member", "group_admin"].includes(String(entry.role))).length,
          lockedMembers: memberUsers.filter((entry) => entry.locked).length,
          codesLeft: codeData.filter((code) => code.active && !code.usedBy).length,
          codesUsed: codeData.filter((code) => code.usedBy).length,
          pendingRequests: requests.filter((row) => (row.data as { status?: string }).status === "pending").length,
          messages: messages.filter((row) => { const message = row.data as { recipientId?: number; senderId?: number }; return message.recipientId === userId || message.senderId === userId; }).length,
          pendingLoans: loanData.filter((loan) => loan.status === "pending").length,
          activeLoans: loanData.filter((loan) => ["disbursed", "overdue"].includes(String(loan.status))).length,
          totalGroupSavingsCents: activeSavings.reduce((sum, entry) => sum + Number(entry.amountCents || 0), 0),
          safeCodeRequired: settings?.safe_code_required === "1",
        };
      }
    }

    const collectionByView = { registrationFees: "registrationFees", savings: "savings", items: "items", safeCodes: "safeCodes", requests: "requests" } as const;
    const collection = collectionByView[view as keyof typeof collectionByView];
    if (collection === "items") {
      const rows = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", collection).eq("groupId", groupId)).take(1000);
      return { status: 200, items: rows.map((row) => row.data).filter((entry) => (entry as { active?: boolean }).active !== false) };
    }
    if (collection === "safeCodes") {
      const rows = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", collection).eq("groupId", groupId)).take(1000);
      return { status: 200, codes: rows.map((row) => row.data as Record<string, unknown>).slice(-200).reverse().map((code) => ({ id: code.id, code: code.code, used: Boolean(code.usedBy), active: Boolean(code.active), createdAt: code.createdAt, usedAt: code.usedAt })) };
    }
    const rows = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", (q) => q.eq("collection", collection).eq("groupId", groupId)).take(1000);
    if (collection === "requests") return { status: 200, requests: rows.map((row) => row.data).slice(-200).reverse() };
    const pending = rows.map((row) => row.data as Record<string, unknown>)
      .filter((entry) => entry.status === "pending" && !entry.reversed && !entry.staffRequest)
      .map((entry) => ({ id: entry.id, groupId: entry.groupId, amountCents: entry.amountCents, week: entry.week, reportedAt: entry.reportedAt, status: entry.status, createdAt: entry.createdAt }));
    return collection === "registrationFees" ? { status: 200, fees: pending } : { status: 200, savings: pending };
  },
});

export const verifyGroupPayment = internalMutation({
  args: { adminId: v.number(), collection: v.union(v.literal("registrationFees"), v.literal("savings")), recordId: v.number(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), record: v.any() }),
  handler: async (ctx, args) => {
    const adminRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.adminId)).unique();
    const admin = adminRow?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role", record: null };
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", args.collection).eq("legacyId", args.recordId)).unique();
    if (!row) return { status: 404, error: args.collection === "registrationFees" ? "Pending registration fee not found" : "Pending savings contribution not found", record: null };
    const payment = row.data as Record<string, unknown>;
    if (payment.groupId !== admin.groupId || payment.status !== "pending" || payment.reversed) return { status: 404, error: "Pending payment not found", record: null };
    if (payment.staffRequest) return { status: 403, error: "Staff member payments require Owner approval.", record: null };
    const memberId = Number(payment.userId);
    const memberRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", memberId)).unique();
    const member = memberRow?.data as Record<string, unknown> | undefined;
    if (!member || member.deleted || member.groupId !== admin.groupId) return { status: 404, error: "Member account not found in your group", record: null };
    if (["super_admin", "admin", "group_admin"].includes(String(member.role))) return { status: 403, error: "Staff member payments require Owner approval.", record: null };
    if (memberId === args.adminId) return { status: 403, error: args.collection === "registrationFees" ? "You cannot verify your own registration fee; the Owner must review it" : "You cannot verify your own savings contribution", record: null };
    if (args.collection === "registrationFees") {
      if (Number(payment.amountCents) !== 20000) return { status: 400, error: "Registration fee amount is invalid", record: null };
      const profiles = await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", memberId)).take(5);
      if (!profiles.length) return { status: 404, error: "Member account not found in your group", record: null };
      const profile = profiles[0].data as Record<string, unknown>;
      if (profile.registrationFeePaid) return { status: 409, error: "Registration fee is already marked paid", record: null };
      await ctx.db.patch(profiles[0]._id, { data: { ...profile, registrationFeePaid: true, registrationFeePaidAt: args.now, updatedAt: args.now } });
    }
    const updated = { ...payment, status: "verified", verifiedAt: args.now, verifiedBy: args.adminId, updatedAt: args.now };
    await ctx.db.patch(row._id, { data: updated });
    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const noticeId = Number(counters.notification || 0) + 1;
    const registration = args.collection === "registrationFees";
    await ctx.db.insert("legacyRecords", {
      collection: "notifications", legacyId: noticeId, userId: memberId,
      ...(typeof member.groupId === "number" ? { groupId: member.groupId } : {}),
      data: {
        id: noticeId, userId: memberId, recipientId: memberId, recipientRole: member.role,
        groupId: member.groupId ?? null, senderId: args.adminId, senderRole: admin.role,
        type: registration ? "registration_fee" : "saving",
        title: registration ? "Registration fee verified" : "Savings contribution verified",
        body: registration ? "Your Group Admin confirmed receipt of your KES 200 registration fee." :
          `Your KES ${(Number(payment.amountCents || 0) / 100).toFixed(2)} savings contribution was verified.`,
        read: false, readAt: null, createdAt: args.now, at: args.now,
      },
    });
    counters.notification = noticeId;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 200, error: null, record: updated };
  },
});

export const transitionGroupLoan = internalMutation({
  args: { adminId: v.number(), loanId: v.number(), type: v.union(v.literal("cash"), v.literal("item")), transition: v.union(v.literal("verify"), v.literal("disburse"), v.literal("clear")), now: v.string(), nowMs: v.number() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), loan: v.any(), fineCents: v.number() }),
  handler: async (ctx, args) => {
    const adminRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.adminId)).unique();
    const admin = adminRow?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role", loan: null, fineCents: 0 };
    const collection = args.type === "cash" ? "cashLoans" : "itemLoans";
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", collection).eq("legacyId", args.loanId)).unique();
    if (!row) return { status: 404, error: "Loan not found", loan: null, fineCents: 0 };
    const loan = row.data as Record<string, unknown>;
    if (loan.groupId !== admin.groupId) return { status: 404, error: "Loan not found", loan: null, fineCents: 0 };
    const borrowerRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", Number(loan.userId))).unique();
    const borrower = borrowerRow?.data as Record<string, unknown> | undefined;
    if (!borrower || borrower.deleted || borrower.role !== "member" || borrower.groupId !== admin.groupId || Number(borrower.id) === args.adminId) {
      return { status: 403, error: "You cannot manage this loan", loan: null, fineCents: 0 };
    }
    const allowed: Record<string, string> = { verify: "pending", disburse: "verified" };
    if (args.transition in allowed && loan.status !== allowed[args.transition]) {
      return { status: 400, error: args.transition === "verify" ? "Loan is not pending" : "Loan must be verified first", loan: null, fineCents: 0 };
    }
    if (args.transition === "clear" && !["disbursed", "overdue"].includes(String(loan.status))) {
      return { status: 400, error: "Loan must be disbursed or overdue to clear", loan: null, fineCents: 0 };
    }
    if (args.transition === "clear" && loan.requiresPaymentReport && !loan.repaymentReportedAt) {
      return { status: 400, error: "Member must report repayment before you can verify and clear this loan", loan: null, fineCents: 0 };
    }
    const nextStatus = args.transition === "verify" ? "verified" : args.transition === "disburse" ? "disbursed" : "cleared";
    const update: Record<string, unknown> = { ...loan, status: nextStatus, updatedAt: args.now };
    if (args.transition === "verify") { update.verifiedAt = args.now; update.verifiedBy = args.adminId; }
    if (args.transition === "disburse") {
      update.disbursedAt = args.now;
      update.dueAt = args.type === "cash" ? new Date(args.nowMs + 14 * 86400000).toISOString() : null;
    }
    let fineCents = 0;
    if (args.transition === "clear") {
      const fineRows = await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "fines").eq("userId", Number(loan.userId))).take(1000);
      const fineRecords = fineRows.map((fineRow) => ({ row: fineRow, data: fineRow.data as Record<string, unknown> }));
      const dueAt = Date.parse(String(loan.dueAt || ""));
      if (args.type === "cash" && Number.isFinite(dueAt) && args.nowMs > dueAt && !fineRecords.some((fine) => fine.data.loanId === args.loanId && !fine.data.reversed)) {
        fineCents = Math.round(Number(loan.amountCents || 0) * 0.01);
      }
      update.clearedAt = args.now;
      update.clearedBy = args.adminId;
      update.fineCents = Number(loan.fineCents || 0) + fineCents;
      if (fineCents > 0) {
        const meta = await ctx.db.query("legacyRecords")
          .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
        const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
        const counters = { ...(metadata.counters || {}) };
        const fineId = Number(counters.fine || 0) + 1;
        const fine = { id: fineId, userId: loan.userId, groupId: loan.groupId, loanId: args.loanId, amountCents: fineCents, paid: false, paidAt: null, verifiedBy: null, idempotencyKey: `fine:loan:${args.loanId}`, reversed: false, reversalOf: null, createdAt: args.now };
        const fineRow = await ctx.db.insert("legacyRecords", { collection: "fines", legacyId: fineId, userId: Number(loan.userId), groupId: Number(loan.groupId), data: fine });
        fineRecords.push({ row: { _id: fineRow } as never, data: fine });
        counters.fine = fineId;
        if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
      }
      for (const entry of fineRecords) {
        if (entry.data.loanId === args.loanId && !entry.data.reversed && !entry.data.paid) {
          await ctx.db.patch(entry.row._id, { data: { ...entry.data, paid: true, paidAt: args.now, verifiedBy: args.adminId } });
        }
      }
    }
    await ctx.db.patch(row._id, { data: update });
    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const noticeId = Number(counters.notification || 0) + 1;
    const title = args.transition === "verify" ? "Loan verified" : args.transition === "disburse" ? "Loan disbursed" : "Loan cleared";
    const body = args.transition === "verify" ? `Your ${args.type} loan was verified by your Group Admin.` : args.transition === "disburse" ? `Your ${args.type} loan has been disbursed.` : `Your ${args.type} loan has been cleared.`;
    await ctx.db.insert("legacyRecords", { collection: "notifications", legacyId: noticeId, userId: Number(loan.userId), groupId: Number(loan.groupId), data: { id: noticeId, userId: loan.userId, recipientId: loan.userId, recipientRole: borrower.role, groupId: loan.groupId, senderId: args.adminId, senderRole: admin.role, type: "loan", title, body, read: false, readAt: null, createdAt: args.now, at: args.now } });
    counters.notification = noticeId;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 200, error: null, loan: update, fineCents };
  },
});

export const createGroupSafeCodes = internalMutation({
  args: { adminId: v.number(), codes: v.array(v.string()), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), codes: v.array(v.string()) }),
  handler: async (ctx, args) => {
    const admin = (await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.adminId)).unique())?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role", codes: [] };
    const groupId = admin.groupId;
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "safeCodes")).take(1000);
    const existingCodes = new Set(rows.map((row) => String((row.data as { code?: string }).code || "")));
    if (args.codes.length < 1 || args.codes.length > 10 || args.codes.some((code) => !/^VD-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code) || existingCodes.has(code))) {
      return { status: 409, error: "Unable to create unique safe codes. Please retry.", codes: [] };
    }
    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const made: string[] = [];
    for (const code of args.codes) {
      const id = Number(counters.safeCode || 0) + 1;
      const safeCode = { id, code, groupId, generatedBy: args.adminId, usedBy: null, usedAt: null, active: true, createdAt: args.now };
      await ctx.db.insert("legacyRecords", { collection: "safeCodes", legacyId: id, groupId, data: safeCode });
      counters.safeCode = id;
      made.push(code);
    }
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 201, error: null, codes: made };
  },
});

export const addGroupItem = internalMutation({
  args: { adminId: v.number(), name: v.string(), description: v.string(), category: v.string(), priceCents: v.number(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), item: v.any() }),
  handler: async (ctx, args) => {
    const adminRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.adminId)).unique();
    const admin = adminRow?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role", item: null };
    if (args.name.trim().length < 2 || args.description.trim().length < 2) return { status: 400, error: "Item name and description are required", item: null };
    if (!Number.isSafeInteger(args.priceCents) || args.priceCents <= 0 || args.priceCents > 100000000) return { status: 400, error: "Item price must be greater than zero and within the supported limit", item: null };
    const category = ["general", "cap", "tshirt"].includes(args.category) ? args.category : "general";
    const meta = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const id = Number(counters.item || 0) + 1;
    const item = { id, groupId: admin.groupId, name: args.name.trim(), description: args.description.trim(), category, priceCents: args.priceCents, active: true, createdBy: args.adminId, createdAt: args.now };
    await ctx.db.insert("legacyRecords", { collection: "items", legacyId: id, groupId: Number(admin.groupId), data: item });
    counters.item = id;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 201, error: null, item };
  },
});

export const handleGroupAccessRequest = internalMutation({
  args: { adminId: v.number(), requestId: v.number(), decision: v.union(v.literal("approve"), v.literal("reject")), code: v.string(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), code: v.union(v.string(), v.null()) }),
  handler: async (ctx, args) => {
    const adminRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.adminId)).unique();
    const admin = adminRow?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role", code: null };
    const requestRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "requests").eq("legacyId", args.requestId)).unique();
    if (!requestRow || requestRow.groupId !== admin.groupId) return { status: 404, error: "Request not found", code: null };
    const requestData = requestRow.data as Record<string, unknown>;
    if (requestData.status !== "pending") return { status: 400, error: "Request already handled", code: null };
    if (args.decision === "reject") {
      await ctx.db.patch(requestRow._id, { data: { ...requestData, status: "rejected", handledAt: args.now, handledBy: args.adminId } });
      return { status: 200, error: null, code: null };
    }
    if (!/^VD-[A-F0-9]{4}-[A-F0-9]{4}$/.test(args.code)) return { status: 400, error: "Unable to issue a safe code", code: null };
    const duplicate = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "safeCodes")).take(5000);
    if (duplicate.some(row => (row.data as { code?: string }).code === args.code)) return { status: 409, error: "Code collision, please retry", code: null };
    const meta = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const codeId = Number(counters.safeCode || 0) + 1;
    const safeCode = { id: codeId, code: args.code, groupId: admin.groupId, generatedBy: args.adminId, usedBy: null, usedAt: null, active: true, createdAt: args.now };
    await ctx.db.insert("legacyRecords", { collection: "safeCodes", legacyId: codeId, groupId: Number(admin.groupId), data: safeCode });
    await ctx.db.patch(requestRow._id, { data: { ...requestData, status: "approved", codeIssued: args.code, handledAt: args.now, handledBy: args.adminId } });
    counters.safeCode = codeId;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 200, error: null, code: args.code };
  },
});

export const announceGroup = internalMutation({
  args: { adminId: v.number(), title: v.string(), body: v.string(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), delivered: v.number() }),
  handler: async (ctx, args) => {
    const adminRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.adminId)).unique();
    const admin = adminRow?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role", delivered: 0 };
    if (args.title.trim().length < 3 || args.body.trim().length < 3) return { status: 400, error: "Title and message required (3+ chars)", delivered: 0 };
    const members = await ctx.db.query("legacyRecords").withIndex("by_collection_and_group_id", q => q.eq("collection", "users").eq("groupId", Number(admin.groupId))).take(300);
    const recipients = members.map(row => row.data as Record<string, unknown>).filter(user => !user.deleted && user.role === "member");
    const meta = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    for (const recipient of recipients) {
      const id = Number(counters.notification || 0) + 1;
      await ctx.db.insert("legacyRecords", {
        collection: "notifications", legacyId: id, userId: Number(recipient.id), groupId: Number(admin.groupId),
        data: { id, userId: Number(recipient.id), recipientId: Number(recipient.id), recipientRole: "member", groupId: admin.groupId, senderId: args.adminId, senderRole: "group_admin", type: "announcement", title: args.title.trim(), body: `${args.body.trim()}\n\n— ${String(admin.firstName || "")} ${String(admin.lastName || "")} (Group Admin)`, read: false, readAt: null, createdAt: args.now, at: args.now },
      });
      counters.notification = id;
    }
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 200, error: null, delivered: recipients.length };
  },
});

export const revokeGroupSafeCode = internalMutation({
  args: { adminId: v.number(), codeId: v.number() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()) }),
  handler: async (ctx, { adminId, codeId }) => {
    const admin = (await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", adminId)).unique())?.data as Record<string, unknown> | undefined;
    if (!admin || admin.role !== "group_admin" || typeof admin.groupId !== "number") return { status: 403, error: "Forbidden: insufficient role" };
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "safeCodes").eq("legacyId", codeId)).unique();
    const code = row?.data as Record<string, unknown> | undefined;
    if (!row || !code || code.groupId !== admin.groupId) return { status: 404, error: "Code not found" };
    if (code.usedBy) return { status: 400, error: "Cannot revoke a code that was already used" };
    await ctx.db.patch(row._id, { data: { ...code, active: false } });
    return { status: 200, error: null };
  },
});

export const notificationsForUser = internalQuery({
  args: { userId: v.number(), groupId: v.union(v.number(), v.null()), role: v.string() },
  returns: v.array(v.any()),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "notifications"))
      .order("desc").take(1000);
    const visible = rows.filter((row) => {
      const n = row.data as Record<string, unknown>;
      if (["v_super_admin", "super_admin"].includes(args.role) && ["admin", "email", "security"].includes(String(n.type))) return false;
      if (args.role !== "admin" && n.type === "security") return false;
      const recipientId = n.recipientId ?? n.userId;
      if (recipientId != null) {
        return Number(recipientId) === args.userId && (!n.recipientRole || n.recipientRole === args.role) &&
          (args.role !== "group_admin" || n.groupId == null || Number(n.groupId) === args.groupId);
      }
      return n.recipientRole === args.role && !["v_super_admin", "super_admin"].includes(args.role) &&
        (n.groupId == null || Number(n.groupId) === args.groupId);
    });
    return visible.slice(0, 100).map((row) => row.data);
  },
});

export const markNotificationRead = internalMutation({
  args: { id: v.number(), userId: v.number(), groupId: v.union(v.number(), v.null()), role: v.string(), now: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "notifications").eq("legacyId", args.id)).unique();
    if (!row) return { ok: false };
    const n = row.data as Record<string, unknown>;
    if (["v_super_admin", "super_admin"].includes(args.role) && ["admin", "email", "security"].includes(String(n.type))) return { ok: false };
    if (args.role !== "admin" && n.type === "security") return { ok: false };
    const recipientId = n.recipientId ?? n.userId;
    const visible = recipientId != null
      ? Number(recipientId) === args.userId && (!n.recipientRole || n.recipientRole === args.role) &&
        (args.role !== "group_admin" || n.groupId == null || Number(n.groupId) === args.groupId)
      : n.recipientRole === args.role && !["v_super_admin", "super_admin"].includes(args.role) &&
        (n.groupId == null || Number(n.groupId) === args.groupId);
    if (!visible) return { ok: false };
    await ctx.db.patch(row._id, { data: { ...n, read: true, readAt: args.now } });
    return { ok: true };
  },
});

function chatPairAllowed(a: Record<string, unknown>, b: Record<string, unknown>, groups: Map<number, Record<string, unknown>>): boolean {
  const allowedRoles = new Set(["member", "group_admin", "admin"]);
  const active = (user: Record<string, unknown>) => {
    if (user.deleted || user.disabled || !allowedRoles.has(String(user.role))) return false;
    if (["member", "group_admin"].includes(String(user.role))) {
      const group = groups.get(Number(user.groupId));
      return Boolean(group && !group.suspended && !group.isStaffChama);
    }
    return true;
  };
  if (!active(a) || !active(b) || a.id === b.id) return false;
  if (a.role === "admin" && b.role === "admin") return true;
  if ((a.role === "admin" && b.role === "group_admin") || (a.role === "group_admin" && b.role === "admin")) return true;
  const member = a.role === "member" ? a : b.role === "member" ? b : null;
  const groupAdmin = a.role === "group_admin" ? a : b.role === "group_admin" ? b : null;
  return Boolean(member && groupAdmin && member.groupId === groupAdmin.groupId);
}

export const chatContacts = internalQuery({
  args: { userId: v.number() },
  returns: v.any(),
  handler: async (ctx, { userId }) => {
    const [currentRow, users, groupRows] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", userId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users")).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups")).take(1000),
    ]);
    const current = currentRow?.data as Record<string, unknown> | undefined;
    if (!current) return { contacts: [] };
    const groups = new Map(groupRows.map(row => [Number(row.legacyId), row.data as Record<string, unknown>]));
    const contacts = users.map(row => row.data as Record<string, unknown>)
      .filter(candidate => chatPairAllowed(current, candidate, groups))
      .map(candidate => ({ id: candidate.id, name: `${String(candidate.firstName || "")} ${String(candidate.lastName || "")}`.trim(), pic: candidate.pic || null, role: candidate.role, pub: candidate.ecdhPub || null }));
    return { contacts };
  },
});

export const chatConversation = internalQuery({
  args: { userId: v.number(), peerId: v.number(), now: v.number() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const [currentRow, peerRow, users, groupRows] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.peerId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "messages")).take(5000),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups")).take(1000),
    ]);
    const current = currentRow?.data as Record<string, unknown> | undefined;
    const peer = peerRow?.data as Record<string, unknown> | undefined;
    const groups = new Map(groupRows.map(row => [Number(row.legacyId), row.data as Record<string, unknown>]));
    if (!current || !peer || !chatPairAllowed(current, peer, groups)) return { status: 404, error: "Conversation is unavailable." };
    const cutoff = args.now - 365 * 86400000;
    const messages = users.map(row => row.data as Record<string, unknown>)
      .filter(message => Date.parse(String(message.at || "")) >= cutoff &&
        ((Number(message.senderId) === args.userId && Number(message.recipientId) === args.peerId) ||
         (Number(message.senderId) === args.peerId && Number(message.recipientId) === args.userId)))
      .sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))).slice(-300)
      .map(message => ({ id: message.id, from: message.senderId, to: message.recipientId, iv: message.iv, ct: message.ct, at: message.at }));
    return { status: 200, peer: { id: peer.id, name: `${String(peer.firstName || "")} ${String(peer.lastName || "")}`.trim(), pic: peer.pic || null, role: peer.role, pub: peer.ecdhPub || null }, messages };
  },
});

export const sendChatMessage = internalMutation({
  args: { senderId: v.number(), peerId: v.number(), iv: v.string(), ciphertext: v.string(), now: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const [senderRow, peerRow, groupRows] = await Promise.all([
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.senderId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.peerId)).unique(),
      ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "groups")).take(1000),
    ]);
    const sender = senderRow?.data as Record<string, unknown> | undefined;
    const peer = peerRow?.data as Record<string, unknown> | undefined;
    const groups = new Map(groupRows.map(row => [Number(row.legacyId), row.data as Record<string, unknown>]));
    if (!sender || !peer || !chatPairAllowed(sender, peer, groups)) return { status: 403, error: "Not an allowed chat partner." };
    if (!/^[A-Za-z0-9+/]{16}$/.test(args.iv) || args.ciphertext.length < 24 || args.ciphertext.length > 32000 || args.ciphertext.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(args.ciphertext)) {
      return { status: 400, error: "Malformed encrypted payload." };
    }
    const metadataRow = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "metadata").eq("legacyId", 0)).unique();
    const metadata = (metadataRow?.data || {}) as { counters?: Record<string, number> };
    const counters = { ...(metadata.counters || {}) };
    const id = Number(counters.message || 0) + 1;
    const data = { id, senderId: args.senderId, recipientId: args.peerId, iv: args.iv, ct: args.ciphertext, at: args.now };
    await ctx.db.insert("legacyRecords", { collection: "messages", legacyId: id, data });
    counters.message = id;
    if (metadataRow) await ctx.db.patch(metadataRow._id, { data: { ...metadata, counters } });
    return { status: 201, id };
  },
});

export const userByEmail = internalQuery({
  args: { email: v.string() },
  returns: v.any(),
  handler: async (ctx, { email }) => {
    const rows = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_email", (q) => q.eq("collection", "users").eq("email", email))
      .take(20);
    return rows.find((row) => !(row.data as { deleted?: boolean }).deleted)?.data ?? null;
  },
});

export const applyLoginFailure = internalMutation({
  args: { userId: v.number() },
  returns: v.object({ failed: v.number(), locked: v.boolean() }),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId))
      .unique();
    if (!row) return { failed: 0, locked: true };
    const user = row.data as Record<string, unknown>;
    const failed = Number(user.failed || 0) + 1;
    const locked = failed >= 4;
    await ctx.db.patch(row._id, { data: { ...user, failed, locked } });
    return { failed, locked };
  },
});

export const userById = internalQuery({
  args: { userId: v.number() },
  returns: v.any(),
  handler: async (ctx, { userId }) => {
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId)).unique();
    return row?.data ?? null;
  },
});

export const updateSelfProfile = internalMutation({
  args: { userId: v.number(), firstName: v.string(), lastName: v.string(), email: v.string(), phone: v.string(), now: v.string() },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), me: v.any() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.userId)).unique();
    if (!row) return { status: 401, error: "Authentication required", me: null };
    const user = row.data as Record<string, unknown>;
    const matches = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_email", (q) => q.eq("collection", "users").eq("email", args.email)).take(20);
    if (matches.some((entry) => Number((entry.data as { id?: number }).id) !== args.userId && !(entry.data as { deleted?: boolean }).deleted)) {
      return { status: 409, error: "That email address is already in use.", me: null };
    }
    const changed = user.firstName !== args.firstName || user.lastName !== args.lastName || user.email !== args.email || (user.phone || "") !== args.phone;
    if (changed) {
      const updated = { ...user, firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone, updatedAt: args.now };
      await ctx.db.patch(row._id, { email: args.email, data: updated });
      const profiles = await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_user_id", (q) => q.eq("collection", "memberProfiles").eq("userId", args.userId)).take(5);
      if (profiles[0]) {
        const profile = profiles[0].data as Record<string, unknown>;
        await ctx.db.patch(profiles[0]._id, { data: { ...profile, updatedAt: args.now } });
      }
      Object.assign(user, updated);
    }
    return {
      status: 200, error: null,
      me: {
        id: user.id, firstName: user.firstName, lastName: user.lastName,
        name: `${String(user.firstName || "")} ${String(user.lastName || "")}`.trim(),
        email: user.email, phone: user.phone, role: user.role, groupId: user.groupId || null,
        pic: user.pic || null, locked: Boolean(user.locked), disabled: Boolean(user.disabled),
        passwordChangeRequired: Boolean(user.passwordChangeRequired), failed: Number(user.failed || 0),
        createdAt: user.createdAt, pub: user.ecdhPub || null,
      },
    };
  },
});

export const saveOwnPublicKey = internalMutation({
  args: { userId: v.number(), jwk: v.string(), now: v.string() },
  returns: v.object({ ok: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("legacyRecords").withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique();
    if (!row) return { ok: false };
    const user = row.data as Record<string, unknown>;
    await ctx.db.patch(row._id, { data: { ...user, ecdhPub: args.jwk, updatedAt: args.now } });
    return { ok: true };
  },
});

export const changeOwnPassword = internalMutation({
  args: { userId: v.number(), passHash: v.string(), currentSessionHash: v.string(), now: v.string() },
  returns: v.object({ ok: v.boolean(), home: v.string() }),
  handler: async (ctx, args) => {
    const userRow = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", q => q.eq("collection", "users").eq("legacyId", args.userId)).unique();
    if (!userRow) throw new Error("Authentication required");
    const user = userRow.data as Record<string, unknown>;
    await ctx.db.patch(userRow._id, { data: { ...user, passHash: args.passHash, passwordChangeRequired: false, updatedAt: args.now } });
    const sessions = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_user_id", q => q.eq("collection", "sessions").eq("userId", args.userId)).take(1000);
    for (const session of sessions) {
      if (session.sessionTokenHash !== args.currentSessionHash) await ctx.db.delete(session._id);
    }
    const homes: Record<string, string> = {
      member: "/member.html", group_admin: "/ga.html", admin: "/admin.html",
      super_admin: "/sa.html", v_super_admin: "/vsa.html",
    };
    return { ok: true, home: homes[String(user.role)] || "/login.html" };
  },
});

export const createSession = internalMutation({
  args: {
    userId: v.number(), sessionTokenHash: v.string(), remember: v.boolean(), loginMethod: v.string(),
    userAgent: v.string(), ip: v.string(), now: v.number(), expires: v.number(),
  },
  returns: v.object({ role: v.string(), home: v.string(), passwordChangeRequired: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", args.userId))
      .unique();
    if (!row) throw new Error("Account unavailable");
    const user = row.data as Record<string, unknown>;
    if (user.deleted || user.disabled || user.locked) throw new Error("Account unavailable");
    await ctx.db.patch(row._id, { data: { ...user, failed: 0 } });
    await ctx.db.insert("legacyRecords", {
      collection: "sessions", legacyId: args.now, sessionTokenHash: args.sessionTokenHash,
      userId: args.userId,
      data: {
        userId: args.userId, remember: args.remember, loginMethod: args.loginMethod,
        ua: args.userAgent.slice(0, 150), ip: args.ip.slice(0, 80), createdAt: args.now, expires: args.expires,
      },
    });
    const homes: Record<string, string> = {
      member: "/member.html", group_admin: "/ga.html", admin: "/admin.html",
      super_admin: "/sa.html", v_super_admin: "/vsa.html",
    };
    const role = typeof user.role === "string" ? user.role : "member";
    return { role, home: homes[role] || "/login.html", passwordChangeRequired: Boolean(user.passwordChangeRequired) };
  },
});

export const sessionUser = internalQuery({
  args: { sessionTokenHash: v.string(), now: v.number() },
  returns: v.any(),
  handler: async (ctx, { sessionTokenHash, now }) => {
    const session = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_session_token_hash", (q) => q.eq("collection", "sessions").eq("sessionTokenHash", sessionTokenHash))
      .unique();
    if (!session || Number((session.data as { expires?: number }).expires || 0) <= now) return null;
    const userId = session.userId;
    if (typeof userId !== "number") return null;
    const user = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "users").eq("legacyId", userId))
      .unique();
    if (!user) return null;
    const data = user.data as Record<string, unknown>;
    if (data.deleted || data.disabled || data.locked) return null;
    if (typeof data.groupId === "number" && data.role !== "v_super_admin") {
      const group = await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups").eq("legacyId", Number(data.groupId)))
        .unique();
      if ((group?.data as { suspended?: boolean } | undefined)?.suspended) return null;
    }
    return { sessionId: session._id, user: data };
  },
});

export const deleteSession = internalMutation({
  args: { sessionTokenHash: v.string() },
  returns: v.null(),
  handler: async (ctx, { sessionTokenHash }) => {
    const session = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_session_token_hash", (q) => q.eq("collection", "sessions").eq("sessionTokenHash", sessionTokenHash))
      .unique();
    if (session) await ctx.db.delete(session._id);
    return null;
  },
});

export const registerMember = internalMutation({
  args: {
    firstName: v.string(), lastName: v.string(), email: v.string(), phone: v.string(),
    passHash: v.string(), safeCode: v.string(), now: v.string(),
  },
  returns: v.object({ status: v.number(), errors: v.any() }),
  handler: async (ctx, args) => {
    const duplicates = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_email", (q) => q.eq("collection", "users").eq("email", args.email))
      .take(20);
    if (duplicates.some((row) => !(row.data as { deleted?: boolean }).deleted)) return { status: 400, errors: { email: "Email already registered" } };

    const meta = await ctx.db.query("legacyRecords")
      .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "metadata").eq("legacyId", 0))
      .unique();
    const metadata = (meta?.data || {}) as { counters?: Record<string, number>; settings?: Record<string, string> };
    const settings = metadata.settings || {};
    const mustUseCode = settings.safe_code_required === "1";
    let groupId: number | null = null;
    let safeCodeRow: (typeof duplicates)[number] | null = null;
    if (mustUseCode || args.safeCode) {
      if (!args.safeCode) return { status: 400, errors: { safeCode: "Safe code required - request one from your Group Admin" } };
      const codes = await ctx.db.query("legacyRecords")
        .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "safeCodes"))
        .take(1000);
      safeCodeRow = codes.find((row) => {
        const code = row.data as { code?: string; active?: boolean; usedBy?: number | null };
        return code.code === args.safeCode && code.active && !code.usedBy;
      }) || null;
      if (!safeCodeRow) return { status: 400, errors: { safeCode: "Invalid, revoked or already-used safe code" } };
      const code = safeCodeRow.data as { groupId?: number };
      if (typeof code.groupId === "number") groupId = code.groupId;
      if (groupId !== null) {
        const group = await ctx.db.query("legacyRecords")
          .withIndex("by_collection_and_legacy_id", (q) => q.eq("collection", "groups").eq("legacyId", groupId!))
          .unique();
        const groupData = group?.data as { suspended?: boolean; isStaffChama?: boolean } | undefined;
        if (!groupData || groupData.isStaffChama) return { status: 400, errors: { safeCode: "A valid savings group is required" } };
        if (groupData.suspended) return { status: 400, errors: { safeCode: "This group is suspended and cannot accept new members" } };
        const members = await ctx.db.query("legacyRecords")
          .withIndex("by_collection_and_group_id", (q) => q.eq("collection", "users").eq("groupId", groupId!))
          .take(300);
        const count = members.filter((row) => {
          const user = row.data as { role?: string; deleted?: boolean };
          return !user.deleted && ["member", "group_admin"].includes(String(user.role));
        }).length;
        if (count >= 30) return { status: 400, errors: { safeCode: "This group has reached its maximum of 30 members" } };
      }
    }

    const counters = { ...(metadata.counters || {}) };
    const userId = Number(counters.user || 0) + 1;
    const profileId = Number(counters.memberProfile || 0) + 1;
    const user = {
      id: userId, firstName: args.firstName, lastName: args.lastName, email: args.email, phone: args.phone,
      role: "member", groupId, passHash: args.passHash, pic: null, ecdhPub: null,
      failed: 0, locked: false, disabled: false, deleted: false, createdAt: args.now, updatedAt: args.now,
    };
    await ctx.db.insert("legacyRecords", {
      collection: "users", legacyId: userId, email: args.email, ...(groupId === null ? {} : { groupId }), data: user,
    });
    await ctx.db.insert("legacyRecords", {
      collection: "memberProfiles", legacyId: profileId, userId,
      ...(groupId === null ? {} : { groupId }),
      data: {
        id: profileId, userId, groupId, registrationFeePaid: false, registrationFeePaidAt: null,
        agreementSigned: false, agreementSignedAt: null, weeklySavingTarget: 0,
        createdAt: args.now, updatedAt: args.now,
      },
    });
    if (safeCodeRow) {
      const code = safeCodeRow.data as Record<string, unknown>;
      await ctx.db.patch(safeCodeRow._id, { data: { ...code, usedBy: userId, usedAt: args.now } });
    }
    counters.user = userId;
    counters.memberProfile = profileId;
    if (meta) await ctx.db.patch(meta._id, { data: { ...metadata, counters } });
    return { status: 201, errors: null };
  },
});
