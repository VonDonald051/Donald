import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

http.route({
  pathPrefix: "/api/",
  method: "OPTIONS",
  handler: httpAction(async (_ctx, request) => {
    const origin = request.headers.get("origin") || "";
    const allowedOrigins = new Set((process.env.CORS_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
    const method = (request.headers.get("access-control-request-method") || "").toUpperCase();
    const requestedHeaders = (request.headers.get("access-control-request-headers") || "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
    const allowedMethods = new Set(["GET", "POST", "PUT", "DELETE"]);
    const allowedHeaders = new Set(["content-type", "x-requested-with"]);
    const headers = secureHeaders(request);
    if (!allowedOrigins.has(origin) || !allowedMethods.has(method) || requestedHeaders.some(value => !allowedHeaders.has(value))) {
      return new Response(null, { status: 403, headers });
    }
    headers.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, X-Requested-With");
    headers.set("Access-Control-Max-Age", "600");
    return new Response(null, { status: 204, headers });
  }),
});

http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const status = await ctx.runQuery(api.health.status, {});
    return Response.json(status, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/auth/groups",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const groups = await ctx.runQuery(internal.legacy.publicGroups, {});
    return Response.json({ groups }, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/auth/branding",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const branding = await ctx.runQuery(internal.legacy.publicBranding, {});
    return Response.json({ branding }, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/auth/register",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") {
      return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    }
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid registration request." }, { status: 400, headers: secureHeaders(request) });
    const input = body as Record<string, unknown>;
    const firstName = typeof input.firstName === "string" ? input.firstName.trim() : "";
    const lastName = typeof input.lastName === "string" ? input.lastName.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const confirmPassword = typeof input.confirmPassword === "string" ? input.confirmPassword : "";
    const safeCode = typeof input.safeCode === "string" ? input.safeCode.trim().toUpperCase() : "";
    const errors: Record<string, string> = {};
    if (!/^[A-Za-z][A-Za-z' -]{1,59}$/.test(firstName)) errors.firstName = "Valid first name required (letters, 2-60 chars)";
    if (!/^[A-Za-z][A-Za-z' -]{1,59}$/.test(lastName)) errors.lastName = "Valid last name required (letters, 2-60 chars)";
    if (email.length < 5 || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Valid email required";
    if (!/^\+?[0-9 ()-]{7,20}$/.test(phone)) errors.phone = "Valid phone number required";
    const passwordIssues = [
      password.length >= 9, /[a-z]/.test(password), /[A-Z]/.test(password),
      /[0-9]/.test(password), /[^A-Za-z0-9]/.test(password),
    ];
    if (passwordIssues.includes(false)) errors.password = "Password needs at least 9 characters, one lowercase letter, one uppercase letter, one number, and one symbol";
    if (password !== confirmPassword) errors.confirmPassword = "Passwords do not match";
    if (safeCode && !/^[A-Z0-9-]{6,32}$/.test(safeCode)) errors.safeCode = "Invalid safe code format";
    if (Object.keys(errors).length) return Response.json({ errors }, { status: 400, headers: secureHeaders(request) });
    const result = await ctx.runAction(internal.auth.register, {
      firstName, lastName, email, phone, password, safeCode, now: new Date().toISOString(),
    });
    return Response.json(result.errors ? { errors: result.errors } : { ok: true }, { status: result.status, headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/auth/login",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") {
      return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    }
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid login request." }, { status: 400, headers: secureHeaders(request) });
    const input = body as Record<string, unknown>;
    const email = typeof input.email === "string" ? input.email.slice(0, 120) : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (!email || !password || password.length > 4096) return Response.json({ error: "Invalid email or password" }, { status: 400, headers: secureHeaders(request) });
    const result = await ctx.runAction(internal.auth.login, {
      email, password, remember: input.remember === true,
      userAgent: request.headers.get("user-agent") || "",
      ip: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "",
      now: Date.now(),
    });
    if (result.status !== 200 || !result.token) {
      return Response.json({ error: result.error || "Authentication failed" }, { status: result.status, headers: secureHeaders(request) });
    }
    const maxAge = input.remember === true ? 30 * 86400 : 8 * 3600;
    const headers = secureHeaders(request);
    headers.set("Set-Cookie", `sid=${result.token}; HttpOnly; Path=/; SameSite=None; Max-Age=${maxAge}; Secure`);
    return Response.json({ ok: true, role: result.role, home: result.home, passwordChangeRequired: result.passwordChangeRequired }, { headers });
  }),
});

http.route({
  path: "/api/auth/logout",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") {
      return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    }
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    await ctx.runAction(internal.auth.logout, { token });
    const headers = secureHeaders(request);
    headers.set("Set-Cookie", "sid=; HttpOnly; Path=/; SameSite=None; Max-Age=0; Secure");
    return Response.json({ ok: true }, { headers });
  }),
});

http.route({
  path: "/api/me",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const user = session.user as Record<string, unknown>;
    const overview = await ctx.runQuery(internal.legacy.memberOverview, { userId: Number(user.id) });
    if (!overview) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    return Response.json(overview, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/loans",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const url = new URL(request.url);
    const result = await ctx.runQuery(internal.legacy.memberLoanPage, {
      userId: Number(session.user.id), page: Number(url.searchParams.get("page") || 1), status: (url.searchParams.get("status") || "").toLowerCase(),
    });
    if (result.status !== 200) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    const { status: _status, ...data } = result;
    return Response.json(data, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/statement",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.memberStatement, { userId: Number(session.user.id) });
    if (result.status !== 200) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    const user = result.user as Record<string, unknown>;
    const savings = result.savings as Record<string, unknown>[];
    const loans = result.loans as Record<string, unknown>[];
    const fines = result.fines as Record<string, unknown>[];
    const fmt = new URL(request.url).searchParams.get("format")?.toLowerCase() || "pdf";
    const date = new Date().toISOString();
    if (fmt === "csv") {
      const csv = (value: unknown) => {
        let cell = String(value == null ? "" : value);
        if (/^[-=+@\t\r]/.test(cell)) cell = "'" + cell;
        return /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
      };
      const rows: unknown[][] = [
        [`${result.brandName} - My Statement`],
        ["Name", `${String(user.firstName || "")} ${String(user.lastName || "")}`],
        ["Email", user.email], ["Phone", user.phone || ""], ["Role", user.role], ["Generated (UTC)", date], [],
        ["Savings"], ["ID", "Amount (KES)", "Week", "Description", "Date"],
        ...savings.map((entry) => [entry.id, (Number(entry.amountCents || 0) / 100).toFixed(2), entry.week || "-", entry.description || "-", String(entry.createdAt || "").slice(0, 10)]),
        [], ["Loans"], ["ID", "Type", "Amount (KES)", "Due", "Fine (KES)", "Status", "Created"],
        ...loans.map((entry) => [entry.id, entry.type, (Number(entry.amountCents || 0) / 100).toFixed(2), entry.dueAt ? String(entry.dueAt).slice(0, 10) : "-", (Number(entry.fineCents || 0) / 100).toFixed(2), entry.status, String(entry.createdAt || "").slice(0, 10)]),
        [], ["Fines"], ["ID", "Amount (KES)", "Paid", "Loan ID", "Created"],
        ...fines.map((entry) => [entry.id, (Number(entry.amountCents || 0) / 100).toFixed(2), entry.paid ? "YES" : "NO", entry.loanId || "-", String(entry.createdAt || "").slice(0, 10)]),
      ];
      const body = "\uFEFF" + rows.map((row) => row.map(csv).join(",")).join("\r\n");
      const headers = secureHeaders(request);
      headers.set("Content-Type", "text/csv; charset=utf-8");
      headers.set("Content-Disposition", `attachment; filename="my-statement-${Number(user.id)}.csv"`);
      return new Response(body, { headers });
    }
    const lines = [
      String(result.brandName || "VonDonald051 Savings"), "My Statement", `Generated (UTC): ${date}`, "",
      `${String(user.firstName || "")} ${String(user.lastName || "")}`, `Email: ${String(user.email || "")}`,
      `Phone: ${String(user.phone || "-")}`, `Role: ${String(user.role || "")}`, "", "Savings",
      ...savings.map((entry) => `KES ${(Number(entry.amountCents || 0) / 100).toFixed(2)} | ${String(entry.week || "-")} | ${String(entry.description || "-")} | ${String(entry.createdAt || "").slice(0, 10)}`),
      "", "Loans",
      ...loans.map((entry) => `#${entry.id} ${String(entry.type || "")} KES ${(Number(entry.amountCents || 0) / 100).toFixed(2)} Due: ${entry.dueAt ? String(entry.dueAt).slice(0, 10) : "-"} Fine: KES ${(Number(entry.fineCents || 0) / 100).toFixed(2)} Status: ${String(entry.status || "")}`),
      "", "Fines",
      ...fines.map((entry) => `#${entry.id} KES ${(Number(entry.amountCents || 0) / 100).toFixed(2)} Paid: ${entry.paid ? "YES" : "NO"} Loan: ${entry.loanId || "-"}`),
      "", "Confidential - generated for the V Super Admin of VonDonald051 Savings.",
    ];
    const headers = secureHeaders(request);
    headers.set("Content-Type", "application/pdf");
    headers.set("Content-Disposition", `attachment; filename="my-statement-${Number(user.id)}.pdf"`);
    return new Response(makeStatementPdf(lines), { headers });
  }),
});

http.route({
  pathPrefix: "/api/me/loans/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const match = new URL(request.url).pathname.match(/^\/api\/me\/loans\/(\d+)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.memberLoanDetail, { userId: Number(session.user.id), loanId: Number(match[1]) });
    if (result.status !== 200) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    return Response.json({ loan: result.loan }, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/me/loans/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/me\/loans\/(\d+)\/repayment-report$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const result = await ctx.runMutation(internal.legacy.reportLoanRepayment, {
      userId: Number(session.user.id), loanId: Number(match[1]), now: new Date().toISOString(), nowMs: Date.now(),
    });
    if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    return Response.json({ ok: true, awaitingVerification: true, repaymentReportedAt: result.repaymentReportedAt }, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/profile",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid profile request." }, { status: 400, headers: secureHeaders(request) });
    const input = body as Record<string, unknown>;
    if (Object.keys(input).some((key) => !["firstName", "lastName", "email", "phone", "currentPassword"].includes(key))) {
      return Response.json({ error: "Only your name, email, and phone can be updated here." }, { status: 400, headers: secureHeaders(request) });
    }
    const user = session.user as Record<string, unknown>;
    const firstName = typeof input.firstName === "string" ? input.firstName.trim() : String(user.firstName || "");
    const lastName = typeof input.lastName === "string" ? input.lastName.trim() : String(user.lastName || "");
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : String(user.email || "");
    const phone = typeof input.phone === "string" ? input.phone.trim() : String(user.phone || "");
    if (!/^[A-Za-z][A-Za-z' -]{1,59}$/.test(firstName) || !/^[A-Za-z][A-Za-z' -]{1,59}$/.test(lastName)) return Response.json({ error: "Enter a valid first and last name." }, { status: 400, headers: secureHeaders(request) });
    if (email.length < 5 || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return Response.json({ error: "Enter a valid email address." }, { status: 400, headers: secureHeaders(request) });
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return Response.json({ error: "Enter a valid phone number." }, { status: 400, headers: secureHeaders(request) });
    const result = await ctx.runAction(internal.auth.updateProfile, {
      userId: Number(user.id), firstName, lastName, email, phone,
      currentPassword: typeof input.currentPassword === "string" ? input.currentPassword : "",
      now: new Date().toISOString(),
    });
    if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    return Response.json({ ok: true, me: result.me }, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/password",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
    if (newPassword !== String(input.confirmPassword || "")) return Response.json({ error: "Passwords do not match" }, { status: 400, headers: secureHeaders(request) });
    const currentSessionHash = await sha256Hex(token);
    const result = await ctx.runAction(internal.auth.changePassword, {
      userId: Number(session.user.id),
      currentPassword: typeof input.currentPassword === "string" ? input.currentPassword : "",
      newPassword, currentSessionHash, now: new Date().toISOString(),
    });
    return result.status !== 200
      ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true, home: result.home }, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/pubkey",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const jwk = body && typeof body === "object" && typeof (body as Record<string, unknown>).jwk === "string" ? String((body as Record<string, unknown>).jwk) : "";
    if (jwk.length < 50 || jwk.length > 2000) return Response.json({ error: "Invalid key" }, { status: 400, headers: secureHeaders(request) });
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(jwk) as Record<string, unknown>; }
    catch { return Response.json({ error: "Invalid key format" }, { status: 400, headers: secureHeaders(request) }); }
    if (parsed.kty !== "EC" || parsed.crv !== "P-256" || typeof parsed.x !== "string" || typeof parsed.y !== "string") {
      return Response.json({ error: "Invalid key format" }, { status: 400, headers: secureHeaders(request) });
    }
    const result = await ctx.runMutation(internal.legacy.saveOwnPublicKey, { userId: Number(session.user.id), jwk, now: new Date().toISOString() });
    return result.ok ? Response.json({ ok: true }, { headers: secureHeaders(request) }) : Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/notifications",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const user = session.user as Record<string, unknown>;
    const notifications = await ctx.runQuery(internal.legacy.notificationsForUser, {
      userId: Number(user.id), groupId: typeof user.groupId === "number" ? user.groupId : null, role: String(user.role || "member"),
    });
    return Response.json({ notifications }, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/me/notifications/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/me\/notifications\/(\d+)\/read$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const user = session.user as Record<string, unknown>;
    const result = await ctx.runMutation(internal.legacy.markNotificationRead, {
      id: Number(match[1]), userId: Number(user.id), groupId: typeof user.groupId === "number" ? user.groupId : null,
      role: String(user.role || "member"), now: new Date().toISOString(),
    });
    return result.ok ? Response.json({ ok: true }, { headers: secureHeaders(request) }) : Response.json({ error: "Notification not found." }, { status: 404, headers: secureHeaders(request) });
  }),
});

for (const [path, kind] of [
  ["/api/me/member-profile/registration-fee", "registrationFee"],
  ["/api/me/member-profile/savings", "saving"],
] as const) {
  http.route({
    path,
    method: "POST",
    handler: httpAction(async (ctx, request) => {
      if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      let body: unknown;
      try { body = await request.json(); }
      catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
      const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const nowDate = new Date();
      const start = new Date(Date.UTC(nowDate.getUTCFullYear(), 0, 1));
      const currentWeek = `${nowDate.getUTCFullYear()}-${Math.ceil((((nowDate.getTime() - start.getTime()) / 86400000) + start.getUTCDay() + 1) / 7)}`;
      const requestedWeek = typeof input.week === "string" ? input.week.slice(0, 8) : "";
      if (kind === "saving" && requestedWeek && requestedWeek !== currentWeek) return Response.json({ error: "Savings can only be recorded for the current week" }, { status: 400, headers: secureHeaders(request) });
      const amount = Number(input.amount || 0);
      const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
      const user = session.user as Record<string, unknown>;
      const result = await ctx.runMutation(internal.legacy.reportMemberFinance, {
        userId: Number(user.id), kind,
        amountCents: kind === "registrationFee" ? 20000 : amountCents,
        description: typeof input.description === "string" ? input.description.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200) : "",
        idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey.slice(0, 120) : crypto.randomUUID(),
        week: currentWeek, now: nowDate.toISOString(),
      });
      if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
      const response = kind === "registrationFee"
        ? { ok: true, pendingVerification: result.pendingVerification, registrationFee: result.record }
        : { ok: true, pendingVerification: result.pendingVerification, saving: result.record };
      return Response.json(response, { status: result.status, headers: secureHeaders(request) });
    }),
  });
}

for (const [path, collection] of [
  ["/api/me/member-profile/savings", "savings"],
  ["/api/me/member-profile/fines", "fines"],
] as const) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      const user = session.user as Record<string, unknown>;
      const result = await ctx.runQuery(internal.legacy.memberLedger, { userId: Number(user.id), collection });
      const status = Number(result.status || 200);
      if (status !== 200) return Response.json({ error: result.error }, { status, headers: secureHeaders(request) });
      const { status: _status, ...data } = result;
      return Response.json(data, { headers: secureHeaders(request) });
    }),
  });
}

http.route({
  path: "/api/me/fines",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const url = new URL(request.url);
    const result = await ctx.runQuery(internal.legacy.memberFinePage, { userId: Number(session.user.id), page: Number(url.searchParams.get("page") || 1) });
    const status = Number(result.status || 200);
    if (status !== 200) return Response.json({ error: result.error }, { status, headers: secureHeaders(request) });
    const { status: _status, ...data } = result;
    return Response.json(data, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/me/finance-trend",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const trend = await ctx.runQuery(internal.legacy.memberFinanceTrend, { userId: Number(session.user.id), now: new Date().toISOString() });
    return Response.json(trend, { headers: secureHeaders(request) });
  }),
});

for (const [path, view] of [
  ["/api/member/overview", "overview"],
  ["/api/member/items", "items"],
  ["/api/member/loans", "loans"],
] as const) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      const user = session.user as Record<string, unknown>;
      const result = await ctx.runQuery(internal.legacy.memberPanel, { userId: Number(user.id), view });
      const status = Number(result.status || 200);
      if (status !== 200) return Response.json({ error: result.error }, { status, headers: secureHeaders(request) });
      if (view === "items") return Response.json({ items: result.items }, { headers: secureHeaders(request) });
      if (view === "loans") return Response.json({ loans: result.loans }, { headers: secureHeaders(request) });
      const { status: _status, ...overview } = result;
      return Response.json(overview, { headers: secureHeaders(request) });
    }),
  });
}

http.route({
  pathPrefix: "/api/ga/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const pathname = new URL(request.url).pathname;
    const paymentMatch = pathname.match(/^\/api\/ga\/(registration-fees|savings)\/(\d+)\/verify$/);
    const loanMatch = pathname.match(/^\/api\/ga\/loans\/(\d+)\/(verify|disburse|clear)$/);
    const requestMatch = pathname.match(/^\/api\/ga\/requests\/(\d+)\/(approve|reject)$/);
    const myLoanMatch = pathname === "/api/ga/my-loans";
    const safeCodeMatch = pathname === "/api/ga/safe-codes";
    const itemMatch = pathname === "/api/ga/items";
    const announceMatch = pathname === "/api/ga/announce";
    if (!paymentMatch && !loanMatch && !requestMatch && !myLoanMatch && !safeCodeMatch && !itemMatch && !announceMatch) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "group_admin") return Response.json({ error: "Forbidden: insufficient role", code: "FORBIDDEN_ROLE" }, { status: 403, headers: secureHeaders(request) });
    if (myLoanMatch) {
      let body: unknown;
      try { body = await request.json(); }
      catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
      const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const type = input.type === "cash" || input.type === "item" ? input.type : null;
      const amount = Number(input.amount || 0);
      const now = new Date();
      const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      const week = `${now.getUTCFullYear()}-${Math.ceil((((now.getTime() - yearStart.getTime()) / 86400000) + yearStart.getUTCDay() + 1) / 7)}`;
      const result = !type
        ? { status: 400, error: "Choose cash or item", loan: null }
        : await ctx.runMutation(internal.legacy.requestMemberLoan, {
          userId: Number(session.user.id), type, amountCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0,
          itemId: Number.isSafeInteger(Number(input.itemId)) && Number(input.itemId) > 0 ? Number(input.itemId) : null,
          idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey.slice(0, 120) : crypto.randomUUID(),
          now: now.toISOString(), week,
        });
      return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
        : Response.json({ ok: true, loan: result.loan }, { status: result.status, headers: secureHeaders(request) });
    }
    if (itemMatch || announceMatch) {
      let body: unknown;
      try { body = await request.json(); }
      catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
      const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
      if (itemMatch) {
        const amount = Number(input.price || 0);
        const result = await ctx.runMutation(internal.legacy.addGroupItem, {
          adminId: Number(session.user.id),
          name: typeof input.name === "string" ? input.name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) : "",
          description: typeof input.description === "string" ? input.description.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500) : "",
          category: typeof input.category === "string" ? input.category : "general",
          priceCents: Number.isFinite(amount) ? Math.round(amount * 100) : 0, now: new Date().toISOString(),
        });
        return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
          : Response.json({ ok: true, item: result.item }, { status: result.status, headers: secureHeaders(request) });
      }
      const result = await ctx.runMutation(internal.legacy.announceGroup, {
        adminId: Number(session.user.id),
        title: typeof input.title === "string" ? input.title.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 100) : "",
        body: typeof input.body === "string" ? input.body.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 1000) : "",
        now: new Date().toISOString(),
      });
      return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
        : Response.json({ ok: true, delivered: result.delivered }, { headers: secureHeaders(request) });
    }
    if (requestMatch) {
      let code = "";
      if (requestMatch[2] === "approve") {
        const bytes = new Uint8Array(4);
        crypto.getRandomValues(bytes);
        const value = Array.from(bytes, byte => byte.toString(16).padStart(2, "0").toUpperCase()).join("");
        code = `VD-${value.slice(0, 4)}-${value.slice(4)}`;
      }
      const result = await ctx.runMutation(internal.legacy.handleGroupAccessRequest, {
        adminId: Number(session.user.id), requestId: Number(requestMatch[1]),
        decision: requestMatch[2] as "approve" | "reject", code, now: new Date().toISOString(),
      });
      return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
        : Response.json({ ok: true, ...(result.code ? { code: result.code } : {}) }, { headers: secureHeaders(request) });
    }
    if (safeCodeMatch) {
      let body: unknown;
      try { body = await request.json(); }
      catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
      const count = Math.min(10, Math.max(1, Math.floor(Number((body as Record<string, unknown> | null)?.count) || 1)));
      const codes = Array.from({ length: count }, () => {
        const bytes = new Uint8Array(4);
        crypto.getRandomValues(bytes);
        const value = Array.from(bytes, (part) => part.toString(16).padStart(2, "0").toUpperCase()).join("");
        return `VD-${value.slice(0, 4)}-${value.slice(4)}`;
      });
      const result = await ctx.runMutation(internal.legacy.createGroupSafeCodes, { adminId: Number(session.user.id), codes, now: new Date().toISOString() });
      if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
      return Response.json({ ok: true, codes: result.codes }, { status: result.status, headers: secureHeaders(request) });
    }
    if (paymentMatch) {
      const result = await ctx.runMutation(internal.legacy.verifyGroupPayment, {
        adminId: Number(session.user.id), collection: paymentMatch[1] === "registration-fees" ? "registrationFees" : "savings",
        recordId: Number(paymentMatch[2]), now: new Date().toISOString(),
      });
      if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
      const record = result.record as Record<string, unknown>;
      const response = paymentMatch[1] === "registration-fees"
        ? { ok: true, fee: { id: record.id, amountCents: record.amountCents, status: record.status, verifiedAt: record.verifiedAt } }
        : { ok: true, saving: { id: record.id, amountCents: record.amountCents, status: record.status, verifiedAt: record.verifiedAt } };
      return Response.json(response, { headers: secureHeaders(request) });
    }
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const type = body && typeof body === "object" && (body as Record<string, unknown>).type === "cash" ? "cash" : "item";
    const now = new Date();
    const result = await ctx.runMutation(internal.legacy.transitionGroupLoan, {
      adminId: Number(session.user.id), loanId: Number(loanMatch![1]), type,
      transition: loanMatch![2] as "verify" | "disburse" | "clear", now: now.toISOString(), nowMs: now.getTime(),
    });
    if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    return Response.json({ ok: true, loan: result.loan, ...(loanMatch![2] === "clear" ? { fineCents: result.fineCents } : {}) }, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/ga/",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/ga\/safe-codes\/(\d+)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "group_admin") return Response.json({ error: "Forbidden: insufficient role", code: "FORBIDDEN_ROLE" }, { status: 403, headers: secureHeaders(request) });
    const result = await ctx.runMutation(internal.legacy.revokeGroupSafeCode, { adminId: Number(session.user.id), codeId: Number(match[1]) });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) }) : Response.json({ ok: true }, { headers: secureHeaders(request) });
  }),
});

for (const [path, view] of [
  ["/api/ga/overview", "overview"], ["/api/ga/members", "members"],
  ["/api/ga/registration-fees", "registrationFees"], ["/api/ga/savings", "savings"],
  ["/api/ga/loans", "loans"], ["/api/ga/items", "items"],
  ["/api/ga/safe-codes", "safeCodes"], ["/api/ga/requests", "requests"],
] as const) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      if (session.user.role !== "group_admin") return Response.json({ error: "Forbidden: insufficient role", code: "FORBIDDEN_ROLE" }, { status: 403, headers: secureHeaders(request) });
      const result = await ctx.runQuery(internal.legacy.groupAdminPanel, { userId: Number(session.user.id), view });
      const status = Number(result.status || 200);
      if (status !== 200) return Response.json({ error: result.error }, { status, headers: secureHeaders(request) });
      const { status: _status, ...data } = result;
      return Response.json(data, { headers: secureHeaders(request) });
    }),
  });
}

http.route({
  path: "/api/member/loans",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session || !session.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    if (!body || typeof body !== "object") return Response.json({ error: "Invalid loan request." }, { status: 400, headers: secureHeaders(request) });
    const input = body as Record<string, unknown>;
    const type = input.type === "item" || input.type === "cash" ? input.type : null;
    const amount = typeof input.amount === "string" || typeof input.amount === "number" ? Number(input.amount) : 0;
    const amountCents = Number.isFinite(amount) ? Math.round(amount * 100) : 0;
    const itemId = Number.isSafeInteger(Number(input.itemId)) && Number(input.itemId) > 0 ? Number(input.itemId) : null;
    const user = session.user as Record<string, unknown>;
    const nowDate = new Date();
    const yearStart = new Date(Date.UTC(nowDate.getUTCFullYear(), 0, 1));
    const week = `${nowDate.getUTCFullYear()}-${Math.ceil((((nowDate.getTime() - yearStart.getTime()) / 86400000) + yearStart.getUTCDay() + 1) / 7)}`;
    const result = !type
      ? { status: 400, error: "Loan type must be cash or item", loan: null }
      : await ctx.runMutation(internal.legacy.requestMemberLoan, {
        userId: Number(user.id), type, amountCents, itemId,
        idempotencyKey: typeof input.idempotencyKey === "string" ? input.idempotencyKey.slice(0, 120) : crypto.randomUUID(),
        now: nowDate.toISOString(), week,
      });
    if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    return Response.json({ ok: true, loan: result.loan }, { status: result.status, headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/chat/contacts",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.chatContacts, { userId: Number(session.user.id) });
    return Response.json(result, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/chat/with/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const match = new URL(request.url).pathname.match(/^\/api\/chat\/with\/(\d+)$/);
    if (!match) return Response.json({ error: "Conversation is unavailable." }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.chatConversation, { userId: Number(session.user.id), peerId: Number(match[1]), now: Date.now() });
    if (result.status !== 200) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    const { status: _status, ...data } = result;
    return Response.json(data, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/chat/send",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const peerId = Number(input.peerId);
    if (!Number.isSafeInteger(peerId) || peerId <= 0 || typeof input.iv !== "string" || typeof input.ct !== "string") {
      return Response.json({ error: "Malformed encrypted payload." }, { status: 400, headers: secureHeaders(request) });
    }
    const result = await ctx.runMutation(internal.legacy.sendChatMessage, {
      senderId: Number(session.user.id), peerId, iv: input.iv.slice(0, 32), ciphertext: input.ct.slice(0, 32001), now: new Date().toISOString(),
    });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true, id: result.id }, { status: result.status, headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/admin/audit",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.adminAudit, {});
    return Response.json(result, { headers: secureHeaders(request) });
  }),
});

for (const [path, role] of [
  ["/api/admin/system-agreements", "admin"],
  ["/api/ga/system-agreements", "group_admin"],
  ["/api/sa/system-agreements", "super_admin"],
  ["/api/vsa/system-agreements", "v_super_admin"],
] as const) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      if (session.user.role !== role) return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
      const groupId = role === "group_admin" ? Number(session.user.groupId) : null;
      const result = await ctx.runQuery(internal.legacy.systemAgreementList, { groupId });
      return Response.json(result, { headers: secureHeaders(request) });
    }),
  });
}

for (const [path, query] of [
  ["/api/vsa/overview", "overview"],
  ["/api/vsa/users", "users"],
] as const) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
      if (query === "overview") {
        const data = await ctx.runQuery(internal.legacy.vsaOverview, {});
        return Response.json(data, { headers: secureHeaders(request) });
      }
      const requestedRole = new URL(request.url).searchParams.get("role") || "";
      const allowedRoles = new Set(["v_super_admin", "super_admin", "admin", "group_admin", "member"]);
      const data = await ctx.runQuery(internal.legacy.vsaUsers, { role: allowedRoles.has(requestedRole) ? requestedRole : undefined });
      return Response.json(data, { headers: secureHeaders(request) });
    }),
  });
}

http.route({
  path: "/api/vsa/groups",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.vsaGroups, {});
    return Response.json(result, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/vsa/settings",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const required = body && typeof body === "object" ? String((body as Record<string, unknown>).safe_code_required ?? "") : "";
    const result = await ctx.runMutation(internal.legacy.updateSafeCodeRequirement, { ownerId: Number(session.user.id), required });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true, safeCodeRequired: result.safeCodeRequired }, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/vsa/users/",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/vsa\/users\/(\d+)\/(unlock|toggle-disabled)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    if (match[2] === "toggle-disabled") {
      let body: unknown;
      try { body = await request.json(); }
      catch { return Response.json({ error: "Re-authentication failed: wrong V Super Admin password" }, { status: 403, headers: secureHeaders(request) }); }
      const password = body && typeof body === "object" && typeof (body as Record<string, unknown>).currentPassword === "string" ? String((body as Record<string, unknown>).currentPassword) : "";
      const verified = await ctx.runAction(internal.auth.verifyOwnerPassword, { ownerId: Number(session.user.id), password });
      if (!verified) return Response.json({ error: "Re-authentication failed: wrong V Super Admin password" }, { status: 403, headers: secureHeaders(request) });
      const changed = await ctx.runMutation(internal.legacy.toggleManagedUserDisabled, { ownerId: Number(session.user.id), userId: Number(match[1]), now: new Date().toISOString() });
      return changed.error ? Response.json({ error: changed.error }, { status: changed.status, headers: secureHeaders(request) })
        : Response.json({ ok: true, disabled: changed.disabled }, { headers: secureHeaders(request) });
    }
    const result = await ctx.runMutation(internal.legacy.unlockAccount, { ownerId: Number(session.user.id), userId: Number(match[1]) });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true }, { headers: secureHeaders(request) });
  }),
});

http.route({
  path: "/api/vsa/users",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const role = input.role === "admin" || input.role === "super_admin" ? input.role : null;
    const firstName = typeof input.firstName === "string" ? input.firstName.trim() : "";
    const lastName = typeof input.lastName === "string" ? input.lastName.trim() : "";
    const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
    const phone = typeof input.phone === "string" ? input.phone.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    const errors: Record<string, string> = {};
    if (!role) errors.role = "Role must be super_admin or admin";
    if (!/^[A-Za-z][A-Za-z' -]{1,59}$/.test(firstName)) errors.firstName = "Valid first name required";
    if (!/^[A-Za-z][A-Za-z' -]{1,59}$/.test(lastName)) errors.lastName = "Valid last name required";
    if (email.length < 5 || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Valid email required";
    if (!/^\+?[0-9 ()-]{7,20}$/.test(phone)) errors.phone = "Valid phone required";
    if (password.length < 9 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) errors.password = "Password needs at least 9 characters, one lowercase letter, one uppercase letter, one number, and one symbol";
    if (password !== String(input.confirmPassword || "")) errors.confirmPassword = "Passwords do not match";
    if (Object.keys(errors).length) return Response.json({ errors }, { status: 400, headers: secureHeaders(request) });
    const result = await ctx.runAction(internal.auth.createStaffUser, {
      ownerId: Number(session.user.id), role: role!, firstName, lastName, email, phone, password, now: new Date().toISOString(),
    });
    if (result.errors) return Response.json({ errors: result.errors }, { status: result.status, headers: secureHeaders(request) });
    if (result.error) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    return Response.json({ ok: true, user: result.user, temporaryPassword: password }, { status: result.status, headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/vsa/users/",
  method: "PUT",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/vsa\/users\/(\d+)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Invalid JSON body" }, { status: 400, headers: secureHeaders(request) }); }
    const input = body && typeof body === "object" ? body as Record<string, unknown> : {};
    const target = await ctx.runQuery(internal.legacy.userById, { userId: Number(match[1]) }) as Record<string, unknown> | null;
    if (!target) return Response.json({ error: "User not found" }, { status: 404, headers: secureHeaders(request) });
    const firstName = typeof input.firstName === "string" && input.firstName ? input.firstName.trim() : String(target.firstName || "");
    const lastName = typeof input.lastName === "string" && input.lastName ? input.lastName.trim() : String(target.lastName || "");
    const email = typeof input.email === "string" && input.email ? input.email.trim().toLowerCase() : String(target.email || "");
    const phone = typeof input.phone === "string" && input.phone ? input.phone.trim() : String(target.phone || "");
    if (!/^[A-Za-z][A-Za-z' -]{1,59}$/.test(firstName) || !/^[A-Za-z][A-Za-z' -]{1,59}$/.test(lastName)) return Response.json({ error: "Invalid name" }, { status: 400, headers: secureHeaders(request) });
    if (email.length < 5 || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return Response.json({ error: "Invalid email" }, { status: 400, headers: secureHeaders(request) });
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return Response.json({ error: "Invalid phone" }, { status: 400, headers: secureHeaders(request) });
    if (input.groupId !== undefined && !["member", "group_admin"].includes(String(target.role))) return Response.json({ error: "This account cannot be assigned to a savings group" }, { status: 400, headers: secureHeaders(request) });
    const currentPassword = typeof input.currentPassword === "string" ? input.currentPassword : "";
    const verified = await ctx.runAction(internal.auth.verifyOwnerPassword, { ownerId: Number(session.user.id), password: currentPassword });
    if (!verified) return Response.json({ error: "Re-authentication failed: wrong V Super Admin password" }, { status: 403, headers: secureHeaders(request) });
    const groupId = input.groupId === undefined ? (typeof target.groupId === "number" ? target.groupId : null) : (Number(input.groupId) || null);
    const result = await ctx.runMutation(internal.legacy.updateManagedUser, { ownerId: Number(session.user.id), userId: Number(match[1]), firstName, lastName, email, phone, groupId, now: new Date().toISOString() });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true, user: result.user }, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/vsa/users/",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/vsa\/users\/(\d+)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    let body: unknown;
    try { body = await request.json(); }
    catch { return Response.json({ error: "Re-authentication failed: wrong V Super Admin password" }, { status: 403, headers: secureHeaders(request) }); }
    const password = body && typeof body === "object" ? String((body as Record<string, unknown>).currentPassword || "") : "";
    const verified = await ctx.runAction(internal.auth.verifyOwnerPassword, { ownerId: Number(session.user.id), password });
    if (!verified) return Response.json({ error: "Re-authentication failed: wrong V Super Admin password" }, { status: 403, headers: secureHeaders(request) });
    const result = await ctx.runMutation(internal.legacy.deleteManagedUser, { ownerId: Number(session.user.id), userId: Number(match[1]), now: new Date().toISOString() });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true }, { headers: secureHeaders(request) });
  }),
});

http.route({
  pathPrefix: "/api/vsa/safe-codes/",
  method: "DELETE",
  handler: httpAction(async (ctx, request) => {
    if (request.headers.get("x-requested-with") !== "XMLHttpRequest") return Response.json({ error: "Request rejected." }, { status: 403, headers: secureHeaders(request) });
    const match = new URL(request.url).pathname.match(/^\/api\/vsa\/safe-codes\/(\d+)$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    const result = await ctx.runMutation(internal.legacy.revokeOwnerSafeCode, { ownerId: Number(session.user.id), codeId: Number(match[1]) });
    return result.error ? Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) })
      : Response.json({ ok: true }, { headers: secureHeaders(request) });
  }),
});

for (const [path, query] of [
  ["/api/vsa/safe-codes", "safeCodes"],
  ["/api/vsa/audit", "audit"],
] as const) {
  http.route({
    path,
    method: "GET",
    handler: httpAction(async (ctx, request) => {
      const token = cookieValue(request.headers.get("cookie") || "", "sid");
      const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
      if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
      if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
      const result = query === "safeCodes"
        ? await ctx.runQuery(internal.legacy.vsaSafeCodes, {})
        : await ctx.runQuery(internal.legacy.vsaAudit, {});
      return Response.json(result, { headers: secureHeaders(request) });
    }),
  });
}

http.route({
  pathPrefix: "/api/vsa/groups/",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const match = new URL(request.url).pathname.match(/^\/api\/vsa\/groups\/(\d+)\/details$/);
    if (!match) return Response.json({ error: "Not found" }, { status: 404, headers: secureHeaders(request) });
    const token = cookieValue(request.headers.get("cookie") || "", "sid");
    const session = token ? await ctx.runAction(internal.auth.findSession, { token, now: Date.now() }) as { user?: Record<string, unknown> } | null : null;
    if (!session?.user) return Response.json({ error: "Authentication required" }, { status: 401, headers: secureHeaders(request) });
    if (session.user.role !== "v_super_admin") return Response.json({ error: "Forbidden: insufficient role" }, { status: 403, headers: secureHeaders(request) });
    const result = await ctx.runQuery(internal.legacy.vsaGroups, { groupId: Number(match[1]) });
    if (result.status !== 200) return Response.json({ error: result.error }, { status: result.status, headers: secureHeaders(request) });
    const { status: _status, ...data } = result;
    return Response.json(data, { headers: secureHeaders(request) });
  }),
});

function secureHeaders(request?: Request): Headers {
  const headers = new Headers({
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
  });
  headers.set("Vary", "Origin");
  const origin = request?.headers.get("origin") || "";
  const allowedOrigins = new Set((process.env.CORS_ALLOWED_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean));
  if (origin && allowedOrigins.has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
  }
  return headers;
}

function cookieValue(raw: string, name: string): string {
  for (const part of raw.split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return "";
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function makeStatementPdf(lines: string[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const escape = (value: string) => value.replace(/[^\x20-\x7e]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 48) pages.push(lines.slice(i, i + 48));
  if (!pages.length) pages.push([]);
  const pageIds = pages.map((_, i) => 4 + i);
  const contentIds = pages.map((_, i) => 4 + pages.length + i);
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  pages.forEach((page, pageIndex) => {
    const operations = page.map((line, lineIndex) => `BT /F1 ${lineIndex === 0 && pageIndex === 0 ? 16 : 9} Tf 46 ${790 - lineIndex * 15} Td (${escape(line.slice(0, 110))}) Tj ET`).join("\n");
    const content = `<< /Length ${encoder.encode(operations).length} >>\nstream\n${operations}\nendstream`;
    objects[pageIds[pageIndex]] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentIds[pageIndex]} 0 R >>`;
    objects[contentIds[pageIndex]] = content;
  });
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = encoder.encode(pdf).length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = encoder.encode(pdf).length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return encoder.encode(pdf).buffer as ArrayBuffer;
}

export default http;
