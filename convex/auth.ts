"use node";

import crypto from "node:crypto";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

type LoginResult = {
  status: number; error: string | null; token: string | null; role: string | null;
  home: string | null; passwordChangeRequired: boolean;
};
type RegisterResult = { status: number; errors: unknown };
type ProfileResult = { status: number; error: string | null; me: unknown };
type SessionResult = { sessionId: unknown; user: Record<string, unknown> } | null;
type PasswordResult = { status: number; error: string | null; home: string | null };

export const login = internalAction({
  args: {
    email: v.string(), password: v.string(), remember: v.boolean(),
    userAgent: v.string(), ip: v.string(), now: v.number(),
  },
  returns: v.object({
    status: v.number(), error: v.union(v.string(), v.null()), token: v.union(v.string(), v.null()),
    role: v.union(v.string(), v.null()), home: v.union(v.string(), v.null()), passwordChangeRequired: v.boolean(),
  }),
  handler: async (ctx, args): Promise<LoginResult> => {
    const email = args.email.trim().toLowerCase();
    const user = await ctx.runQuery(internal.legacy.userByEmail, { email }) as Record<string, unknown> | null;
    if (!user || user.deleted) {
      return { status: 401, error: "Invalid email or password", token: null, role: null, home: null, passwordChangeRequired: false };
    }
    if (user.disabled || user.locked) {
      return { status: 423, error: user.disabled ? "This account has been disabled. Contact the V Super Admin." : "Account locked after 4 failed attempts. Ask the V Super Admin to re-enable it.", token: null, role: null, home: null, passwordChangeRequired: false };
    }

    const stored = String(user.passHash || "");
    let valid = false;
    const match = stored.match(/^s2\$([a-f0-9]{32})\$([a-f0-9]{128})$/i);
    if (match && args.password.length <= 4096) {
      try {
        const actual = crypto.scryptSync(args.password, Buffer.from(match[1], "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        valid = crypto.timingSafeEqual(actual, Buffer.from(match[2], "hex"));
      } catch { valid = false; }
    }
    if (!valid) {
      const result: { failed: number; locked: boolean } = await ctx.runMutation(internal.legacy.applyLoginFailure, { userId: Number(user.id) });
      return {
        status: result.locked ? 423 : 401,
        error: result.locked ? "Account locked after 4 failed attempts. Ask the V Super Admin to re-enable it." : `Invalid email or password (${4 - result.failed} attempt(s) left before lockout)`,
        token: null, role: null, home: null, passwordChangeRequired: false,
      };
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const ttl = args.remember ? 30 * 86400000 : 8 * 3600000;
    const session: { role: string; home: string; passwordChangeRequired: boolean } = await ctx.runMutation(internal.legacy.createSession, {
      userId: Number(user.id), sessionTokenHash: tokenHash, remember: args.remember,
      loginMethod: "password", userAgent: args.userAgent, ip: args.ip,
      now: args.now, expires: args.now + ttl,
    });
    return { status: 200, error: null, token, ...session };
  },
});

export const register = internalAction({
  args: {
    firstName: v.string(), lastName: v.string(), email: v.string(), phone: v.string(), password: v.string(), safeCode: v.string(), now: v.string(),
  },
  returns: v.object({ status: v.number(), errors: v.any() }),
  handler: async (ctx, args): Promise<RegisterResult> => {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(args.password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return await ctx.runMutation(internal.legacy.registerMember, {
      firstName: args.firstName, lastName: args.lastName, email: args.email,
      phone: args.phone, safeCode: args.safeCode,
      passHash: `s2$${salt.toString("hex")}$${hash.toString("hex")}`,
      now: args.now,
    });
  },
});

export const findSession = internalAction({
  args: { token: v.string(), now: v.number() },
  returns: v.any(),
  handler: async (ctx, { token, now }): Promise<SessionResult> => {
    if (!/^[a-f0-9]{64}$/i.test(token)) return null;
    const sessionTokenHash = crypto.createHash("sha256").update(token).digest("hex");
    return await ctx.runQuery(internal.legacy.sessionUser, { sessionTokenHash, now }) as SessionResult;
  },
});

export const updateProfile = internalAction({
  args: {
    userId: v.number(), firstName: v.string(), lastName: v.string(), email: v.string(), phone: v.string(),
    currentPassword: v.string(), now: v.string(),
  },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), me: v.any() }),
  handler: async (ctx, args): Promise<ProfileResult> => {
    const user = await ctx.runQuery(internal.legacy.userById, { userId: args.userId }) as Record<string, unknown> | null;
    if (!user) return { status: 401, error: "Authentication required", me: null };
    const needsReauthentication = args.email !== user.email || args.phone !== (user.phone || "");
    if (needsReauthentication) {
      const stored = String(user.passHash || "");
      const match = stored.match(/^s2\$([a-f0-9]{32})\$([a-f0-9]{128})$/i);
      if (!match || args.currentPassword.length > 4096) return { status: 403, error: "Your current password is required to change your email or phone.", me: null };
      let verified = false;
      try {
        const actual = crypto.scryptSync(args.currentPassword, Buffer.from(match[1], "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        verified = crypto.timingSafeEqual(actual, Buffer.from(match[2], "hex"));
      } catch { verified = false; }
      if (!verified) return { status: 403, error: "Your current password is required to change your email or phone.", me: null };
    }
    return await ctx.runMutation(internal.legacy.updateSelfProfile, {
      userId: args.userId, firstName: args.firstName, lastName: args.lastName,
      email: args.email, phone: args.phone, now: args.now,
    });
  },
});

export const changePassword = internalAction({
  args: {
    userId: v.number(), currentPassword: v.string(), newPassword: v.string(),
    currentSessionHash: v.string(), now: v.string(),
  },
  returns: v.object({ status: v.number(), error: v.union(v.string(), v.null()), home: v.union(v.string(), v.null()) }),
  handler: async (ctx, args): Promise<PasswordResult> => {
    if (args.currentPassword.length > 4096 || args.newPassword.length > 4096) {
      return { status: 400, error: "Password is too long", home: null };
    }
    const user = await ctx.runQuery(internal.legacy.userById, { userId: args.userId }) as Record<string, unknown> | null;
    if (!user) return { status: 401, error: "Authentication required", home: null };
    const stored = String(user.passHash || "");
    const match = stored.match(/^s2\$([a-f0-9]{32})\$([a-f0-9]{128})$/i);
    let valid = false;
    if (match) {
      try {
        const actual = crypto.scryptSync(args.currentPassword, Buffer.from(match[1], "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        valid = crypto.timingSafeEqual(actual, Buffer.from(match[2], "hex"));
      } catch { valid = false; }
    }
    if (!valid) return { status: 403, error: "Current password is wrong", home: null };
    const pw = args.newPassword;
    const issues = [
      ...(pw.length < 9 ? ["at least 9 characters"] : []),
      ...(!/[a-z]/.test(pw) ? ["a lowercase letter"] : []),
      ...(!/[A-Z]/.test(pw) ? ["an uppercase letter"] : []),
      ...(!/[0-9]/.test(pw) ? ["a number"] : []),
      ...(!/[^A-Za-z0-9]/.test(pw) ? ["a symbol"] : []),
    ];
    if (issues.length) return { status: 400, error: "New password needs " + issues.join(", "), home: null };
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const result: { ok: boolean; home: string } = await ctx.runMutation(internal.legacy.changeOwnPassword, {
      userId: args.userId, passHash: `s2$${salt.toString("hex")}$${hash.toString("hex")}`,
      currentSessionHash: args.currentSessionHash, now: args.now,
    });
    return { status: 200, error: null, home: result.home };
  },
});

export const verifyOwnerPassword = internalAction({
  args: { ownerId: v.number(), password: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const user = await ctx.runQuery(internal.legacy.userById, { userId: args.ownerId }) as Record<string, unknown> | null;
    if (!user || user.role !== "v_super_admin" || args.password.length > 4096) return false;
    const match = String(user.passHash || "").match(/^s2\$([a-f0-9]{32})\$([a-f0-9]{128})$/i);
    if (!match) return false;
    try {
      const actual = crypto.scryptSync(args.password, Buffer.from(match[1], "hex"), 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      return crypto.timingSafeEqual(actual, Buffer.from(match[2], "hex"));
    } catch { return false; }
  },
});

export const createStaffUser = internalAction({
  args: {
    ownerId: v.number(), role: v.union(v.literal("super_admin"), v.literal("admin")), firstName: v.string(),
    lastName: v.string(), email: v.string(), phone: v.string(), password: v.string(), now: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(args.password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return await ctx.runMutation(internal.legacy.createManagedStaffAccount, {
      ownerId: args.ownerId, role: args.role, firstName: args.firstName, lastName: args.lastName,
      email: args.email, phone: args.phone,
      passHash: `s2$${salt.toString("hex")}$${hash.toString("hex")}`, now: args.now,
    });
  },
});

export const logout = internalAction({
  args: { token: v.string() },
  returns: v.null(),
  handler: async (ctx, { token }) => {
    if (/^[a-f0-9]{64}$/i.test(token)) {
      const sessionTokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await ctx.runMutation(internal.legacy.deleteSession, { sessionTokenHash });
    }
    return null;
  },
});
