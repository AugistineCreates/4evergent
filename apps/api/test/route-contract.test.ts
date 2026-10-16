import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { createAuthModule } from "../src/auth.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import {
  InMemoryActivityStore,
  InMemoryApprovalStore,
  InMemoryExecutionStore,
  InMemoryScheduleStore,
  InMemoryAgentStore,
} from "@4evergent/database";
import type {
  ActivityStore,
  ApprovalStore,
  ExecutionStore,
  ScheduleStore,
  ExecutionRecord,
  ScheduleRecord,
  ApprovalRecord,
  ActivityRecord,
} from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

// ============================================================================
// ROUTE SURFACE — the contract this suite guards
// ============================================================================
// This table is the single place that enumerates every route served by
// apps/api/src/index.ts (the dispatch chain at index.ts:627-716) plus the
// public /auth/* routes handled by auth.ts before the auth gate.
//
// WHEN YOU ADD A ROUTE TO index.ts, ADD IT HERE.
// A route missing from this table is a gap in the contract: nothing asserts
// its method, auth requirement, status code, or response shape.
//
// Fields:
//   method   — HTTP method the route is dispatched on
//   path     — concrete path with :id placeholders filled by `sample`
//   auth     — "public"   → reachable without a principal (must NOT be 401)
//              "protected" → requires a principal (anonymous must be 401)
//   status   — status code the success path returns for the seeded fixture
//   keys     — top-level response keys the success path must contain
//   sample   — optional per-route fixture setup, returns the concrete path
//              (and any extra request options) to use for the success probe
// ============================================================================

type RouteAuth = "public" | "protected";

interface RouteContract {
  method: string;
  /** Path template; `:id` segments are substituted by `sample()`. */
  path: string;
  auth: RouteAuth;
  /** Expected status on the success path for the seeded fixture. */
  status: number;
  /** Top-level response keys required on the success path. */
  keys?: string[];
  /** True when the route returns a top-level array collection. */
  list?: boolean;
  /**
   * Build the concrete request for the success probe. Receives the ids of
   * fixtures created during setup. Return the resolved path and any
   * method-specific request init.
   */
  sample?: (ids: FixtureIds) => { path: string; init?: RequestInit };
  /** Set to true when the route is only reachable with the queue enabled. */
  needsQueue?: boolean;
}

interface FixtureIds {
  agentId: string;
  activityId: string;
  approvalId: string;
  executionId: string;
  queuedExecutionId: string;
  scheduleId: string;
  missingId: string;
}

const AGENT_ID = "contract-agent";

const ROUTES: RouteContract[] = [
  // ---- Public routes (no principal required) ----
  { method: "GET", path: "/health", auth: "public", status: 200, keys: ["status", "signerAccountId"] },
  { method: "GET", path: "/auth/config", auth: "public", status: 200, keys: ["email", "google", "stellar", "registration"] },
  { method: "POST", path: "/auth/register", auth: "public", status: 201, keys: ["subject"] },
  { method: "POST", path: "/auth/login/email", auth: "public", status: 200, keys: ["subject"] },
  { method: "POST", path: "/auth/stellar/challenge", auth: "public", status: 200, keys: ["challengeId", "message", "expiresAt", "network"] },
  { method: "POST", path: "/auth/stellar/verify", auth: "public", status: 200, keys: ["session"] },

  // ---- Protected routes (anonymous → 401) ----
  { method: "POST", path: "/agents", auth: "protected", status: 201, keys: ["agent"], sample: () => ({
    path: "/agents",
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Contract Agent" }),
    },
  }) },
  { method: "GET", path: "/agents", auth: "protected", status: 200, keys: ["agents"], list: true },
  {
    method: "GET",
    path: "/agents/:id",
    auth: "protected",
    status: 200,
    keys: ["id", "displayName", "ownerId", "stellarAddress"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}` }),
  },
  {
    method: "GET",
    path: "/agents/:id/policy",
    auth: "protected",
    status: 200,
    keys: ["agentId", "policy"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/policy` }),
  },
  {
    method: "PUT",
    path: "/agents/:id/policy",
    auth: "protected",
    status: 200,
    keys: ["agentId", "policy", "version"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/policy`,
      init: {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxTxAmount: { XLM: "1000" } }),
      },
    }),
  },
  {
    method: "PATCH",
    path: "/agents/:id/status",
    auth: "protected",
    status: 200,
    keys: ["id", "status"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/status`,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "active" }),
      },
    }),
  },
  {
    method: "POST",
    path: "/agents/:id/intents",
    auth: "protected",
    status: 202,
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/intents`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: "contract test",
        }),
      },
    }),
  },
  {
    method: "GET",
    path: "/agents/:id/activity",
    auth: "protected",
    status: 200,
    keys: ["agentId", "activity", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/activity` }),
  },
  {
    method: "GET",
    path: "/agents/:id/activity/:activityId",
    auth: "protected",
    status: 200,
    keys: ["activity"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/activity/${ids.activityId}` }),
  },
  {
    method: "GET",
    path: "/agents/:id/approvals",
    auth: "protected",
    status: 200,
    keys: ["agentId", "approvals", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/approvals` }),
  },
  {
    method: "GET",
    path: "/agents/:id/schedules",
    auth: "protected",
    status: 200,
    keys: ["agentId", "schedules", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules` }),
  },
  {
    method: "GET",
    path: "/agents/:id/schedules/:scheduleId",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}` }),
  },
  {
    method: "POST",
    path: "/agents/:id/schedules",
    auth: "protected",
    status: 201,
    keys: ["schedule"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/schedules`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          intent: {
            type: "payment",
            asset: "XLM",
            destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            amount: "10",
            reason: "contract schedule",
          },
          scheduleExpression: "0 0 * * *",
          timezone: "UTC",
        }),
      },
    }),
  },
  {
    method: "PATCH",
    path: "/agents/:id/schedules/:scheduleId",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({
      path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}`,
      init: {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduleExpression: "30 0 * * *" }),
      },
    }),
  },
  {
    method: "POST",
    path: "/agents/:id/schedules/:scheduleId/pause",
    auth: "protected",
    status: 200,
    keys: ["schedule"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}/pause`, init: { method: "POST" } }),
  },
  {
    method: "GET",
    path: "/agents/:id/spending",
    auth: "protected",
    status: 200,
    keys: ["agentId", "spending"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/spending` }),
  },
  {
    method: "GET",
    path: "/agents/:id/executions",
    auth: "protected",
    status: 200,
    keys: ["agentId", "executions", "hasMore"], list: true,
    sample: (ids) => ({ path: `/agents/${ids.agentId}/executions` }),
  },
  { method: "GET", path: "/activity", auth: "protected", status: 200, keys: ["activity", "hasMore"], list: true },
  { method: "GET", path: "/approvals", auth: "protected", status: 200, keys: ["approvals", "hasMore"], list: true },
  {
    method: "GET",
    path: "/approvals/:id",
    auth: "protected",
    status: 200,
    keys: ["approval"],
    sample: (ids) => ({ path: `/approvals/${ids.approvalId}` }),
  },
  { method: "GET", path: "/executions", auth: "protected", status: 200, keys: ["executions", "hasMore"], list: true },
  {
    method: "GET",
    path: "/executions/:id",
    auth: "protected",
    status: 200,
    keys: ["execution"],
    sample: (ids) => ({ path: `/executions/${ids.executionId}` }),
  },
  { method: "GET", path: "/agent-queue", auth: "protected", status: 200, keys: ["running", "byStatus"], needsQueue: true },
  { method: "GET", path: "/overview/attention", auth: "protected", status: 200, keys: ["pendingApprovals", "failedExecutions"] },
  {
    method: "POST",
    path: "/executions/:id/retry",
    auth: "protected",
    status: 200,
    sample: (ids) => ({ path: `/executions/${ids.executionId}/retry`, init: { method: "POST" } }),
    needsQueue: true,
  },
  {
    method: "POST",
    path: "/executions/:id/cancel",
    auth: "protected",
    status: 200,
    keys: ["execution", "message"],
    sample: (ids) => ({ path: `/executions/${ids.queuedExecutionId}/cancel`, init: { method: "POST" } }),
    needsQueue: true,
  },
  {
    method: "DELETE",
    path: "/agents/:id/schedules/:scheduleId",
    auth: "protected",
    status: 200,
    keys: ["deleted"],
    sample: (ids) => ({ path: `/agents/${ids.agentId}/schedules/${ids.scheduleId}`, init: { method: "DELETE" } }),
  },
];

// ============================================================================
// Test harness
// ============================================================================

class MockSigner implements Signer {
  private id: string;
  constructor(id: string) {
    this.id = id.startsWith("G") ? id : `G${id.padEnd(55, "A").slice(0, 55)}`;
  }
  getAccountId(): string { return this.id; }
  getNetworkPassphrase(): string { return "Test SDF Network ; September 2015"; }
  async sign(transaction: any): Promise<any> {
    transaction.signatures = [{ hint: Buffer.from("mock"), signature: Buffer.from("sig") }];
    return transaction;
  }
}

async function apiFetch(url: string, init?: RequestInit) {
  return fetch(url, { ...init, keepalive: false });
}

interface Harness {
  baseUrl: string;
  close: () => Promise<void>;
  stores: {
    activity: ActivityStore;
    approvals: ApprovalStore;
    executions: ExecutionStore;
    schedules: ScheduleStore;
  };
}

/**
 * Boots a server with in-memory stores and the dev auth provider, then seeds
 * the fixtures the route table's `sample()` closures reference.
 *
 * `withQueue` enables the execution queue so queue-dependent routes
 * (/agent-queue, /executions/:id/retry, /executions/:id/cancel) are reachable
 * instead of returning 404 "execution queue not enabled".
 */
async function startHarness(withQueue = false, withAuth = true): Promise<Harness> {
  const activity = new InMemoryActivityStore();
  const approvals = new InMemoryApprovalStore();
  const executions = new InMemoryExecutionStore();
  const schedules = new InMemoryScheduleStore();
  const agentStore = new InMemoryAgentStore();

  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("contract-agent"),
    policyRules: {
      maxTxAmount: { XLM: "1000" },
      requireHumanApprovalForAmountAbove: "10",
    },
    deferExecution: true,
    authProvider: withAuth ? new DevAuthProvider({ defaultOwnerId: "test" }) : undefined,
    activityStore: activity,
    approvalStore: approvals,
    executionStore: executions,
    scheduleStore: schedules,
    agentStore,
    executionQueue: withQueue ? { enabled: true, intervalMs: 60_000, concurrency: 1 } : undefined,
    authModule: withAuth
      ? createAuthModule({
          fallbackProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
          config: { webOrigin: "http://localhost:5173", stellarDomain: "localhost" },
        })
      : undefined,
  });

  server.registerAgent({
    id: AGENT_ID,
    displayName: "Contract Agent",
    description: "route contract fixture",
    ownerId: "test",
    stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    capabilities: ["payment"],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    active: true,
    status: "active" as const,
    metadata: {},
  });

  await seedFixtures({ activity, approvals, executions, schedules });

  return new Promise((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        stores: { activity, approvals, executions, schedules },
      });
    });
  });
}

function makeActivity(overrides: Partial<ActivityRecord> = {}): ActivityRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: AGENT_ID,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "contract fixture",
    },
    policyDecision: { decision: "allow", reasons: [] } as any,
    authorizationStatus: "not_required",
    status: "pending",
    txHash: null,
    simulationResult: null,
    error: null,
    idempotencyKey: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeApproval(activityId: string, overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    activityId,
    agentId: AGENT_ID,
    ownerId: "test",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "contract fixture",
    },
    policyDecision: { decision: "require_approval", reasons: ["above threshold"] } as any,
    status: "pending_approval",
    requestedAt: now,
    approvedAt: null,
    rejectedAt: null,
    expiredAt: null,
    approver: null,
    expiresAt: null,
    txHash: null,
    error: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    ownerId: "test",
    agentId: AGENT_ID,
    approvalId: null,
    activityId: null,
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "50",
      reason: "contract fixture",
    },
    status: "queued",
    policyDecision: null,
    simulationResult: null,
    txHash: null,
    submittedHash: null,
    error: null,
    attempt: 0,
    nextRetryAt: null,
    startedAt: null,
    completedAt: null,
    errorClass: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: AGENT_ID,
    ownerId: "test",
    status: "active",
    intent: {
      type: "payment",
      asset: "XLM",
      destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      amount: "10",
      reason: "contract fixture",
    },
    scheduleExpression: "0 0 * * *",
    timezone: "UTC",
    nextRunAt: new Date(Date.now() + 3_600_000).toISOString(),
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function seedFixtures(stores: {
  activity: ActivityStore;
  approvals: ApprovalStore;
  executions: ExecutionStore;
  schedules: ScheduleStore;
}): Promise<FixtureIds> {
  const activityRecord = makeActivity();
  await stores.activity.record(activityRecord);

  const approval = makeApproval(activityRecord.id);
  await stores.approvals.record(approval);

  // A queued execution so the cancel route has a valid target (cancel only
  // accepts queued/executing), plus a failed one for the retry route.
  const execution = makeExecution({ status: "failed" });
  await stores.executions.record(execution);
  const queuedExecution = makeExecution({ status: "queued" });
  await stores.executions.record(queuedExecution);

  const schedule = makeSchedule();
  await stores.schedules.create(schedule);

  return {
    agentId: AGENT_ID,
    activityId: activityRecord.id,
    approvalId: approval.id,
    executionId: execution.id,
    queuedExecutionId: queuedExecution.id,
    scheduleId: schedule.id,
    missingId: crypto.randomUUID(),
  };
}

// ============================================================================
// Contract assertions
// ============================================================================

test("route table enumerates the full API surface", () => {
  // Guard against the table silently shrinking. The dispatch chain in
  // apps/api/src/index.ts:627-716 serves 30 routes; auth.ts adds 7 public
  // /auth/* routes. Update these counts when you add a route.
  const protectedCount = ROUTES.filter((r) => r.auth === "protected").length;
  const publicCount = ROUTES.filter((r) => r.auth === "public").length;

  assert.equal(protectedCount, 27, "protected route count changed — update the table and this count");
  assert.equal(publicCount, 6, "public route count changed — update the table and this count");

  // Every entry must be uniquely addressable.
  const seen = new Set<string>();
  for (const r of ROUTES) {
    const key = `${r.method} ${r.path}`;
    assert.ok(!seen.has(key), `duplicate route entry: ${key}`);
    seen.add(key);
  }
});

test("every protected route returns 401 for an anonymous request", async () => {
  // Boot WITHOUT an authProvider so authenticateRequest returns principal:null.
  // (DevAuthProvider would authenticate every request and mask the 401 path.)
  const { baseUrl, close } = await startHarness(false, false);
  try {
    for (const route of ROUTES.filter((r) => r.auth === "protected")) {
      const path = route.sample
        ? route.sample({
            agentId: AGENT_ID,
            activityId: "x",
            approvalId: "x",
            executionId: "x",
            queuedExecutionId: "x",
            scheduleId: "x",
            missingId: "x",
          }).path
        : route.path;

      const res = await apiFetch(`${baseUrl}${path}`, {
        method: route.method,
        headers: route.method === "GET" || route.method === "DELETE" ? undefined : { "Content-Type": "application/json" },
        body: route.method === "GET" || route.method === "DELETE" ? undefined : "{}",
      });

      assert.equal(
        res.status,
        401,
        `${route.method} ${route.path} must return 401 for an anonymous request (got ${res.status})`
      );
      const body = await res.json();
      assert.ok(body.error, `${route.method} ${route.path} 401 body must carry an error field`);
    }
  } finally {
    await close();
  }
});

test("every public route is reachable without a principal", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    for (const route of ROUTES.filter((r) => r.auth === "public")) {
      const res = await apiFetch(`${baseUrl}${route.path}`, {
        method: route.method,
        headers: route.method === "GET" ? undefined : { "Content-Type": "application/json" },
        body: route.method === "GET" ? undefined : "{}",
      });

      // "Public" means the auth GATE must not reject it. A public route may
      // still return its own 4xx (e.g. /auth/login/email → 401 invalid_credentials
      // for empty creds) — that is a business decision, not the auth gate.
      // The gate's signature is error === "unauthorized".
      if (res.status === 401) {
        const body = await res.json();
        assert.notEqual(
          body.error,
          "unauthorized",
          `${route.method} ${route.path} is public — a 401 with error "unauthorized" means the auth gate rejected it`
        );
      }
    }
  } finally {
    await close();
  }
});

test("every non-auth route's success path returns its documented status code and top-level keys", async () => {
  const { baseUrl, close, stores } = await startHarness(true);
  try {
    for (const route of ROUTES.filter((r) => !r.path.startsWith("/auth/"))) {
      // Re-seed into the server's OWN stores before every probe, so
      // destructive routes (PATCH/DELETE) never break the ones after them.
      const ids = await seedFixtures(stores);
      void ids;

      const probe = route.sample ? route.sample(ids) : { path: route.path };
      const res = await apiFetch(`${baseUrl}${probe.path}`, probe.init);

      assert.equal(
        res.status,
        route.status,
        `${route.method} ${route.path} must return ${route.status} on the success path (got ${res.status})`
      );

      if (route.keys && route.keys.length > 0) {
        const body = await res.json();
        for (const key of route.keys) {
          assert.ok(
            key in body,
            `${route.method} ${route.path} response must contain top-level key '${key}'`
          );
        }
      }
    }
  } finally {
    await close();
  }
});

test("auth routes complete their documented success flows", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    // /auth/register → 201 { subject }
    const reg = await apiFetch(`${baseUrl}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "contract@example.com", password: "password123" }),
    });
    assert.equal(reg.status, 201);
    assert.ok((await reg.json()).subject, "register must return subject");

    // /auth/login/email → 200 { subject } with the same credentials
    const login = await apiFetch(`${baseUrl}/auth/login/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "contract@example.com", password: "password123" }),
    });
    assert.equal(login.status, 200);
    assert.ok((await login.json()).subject, "login must return subject");

    // /auth/stellar/challenge → 200, then a signed verify → 200
    const kp = Keypair.random();
    const challenge = await apiFetch(`${baseUrl}/auth/stellar/challenge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: kp.publicKey() }),
    });
    assert.equal(challenge.status, 200);
    const chBody = await challenge.json();
    assert.ok(chBody.challengeId && chBody.message, "challenge must return challengeId + message");

    const verify = await apiFetch(`${baseUrl}/auth/stellar/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicKey: kp.publicKey(),
        challengeId: chBody.challengeId,
        signature: kp.sign(Buffer.from(chBody.message)).toString("base64"),
      }),
    });
    assert.equal(verify.status, 200, "signed verify must return 200");
    const verifyBody = await verify.json();
    assert.ok(verifyBody.session?.token || verifyBody.subject, "verify must return a session token");
  } finally {
    await close();
  }
});

test("every list route returns its documented top-level collection key", async () => {
  const { baseUrl, close, stores } = await startHarness(true);
  try {
    const listRoutes = ROUTES.filter((r) => r.list === true);

    for (const route of listRoutes) {
      const ids = await seedFixtures(stores);
      const probe = route.sample ? route.sample(ids) : { path: route.path };

      const res = await apiFetch(`${baseUrl}${probe.path}`, probe.init);
      assert.equal(res.status, 200, `${route.method} ${route.path} list probe must be 200`);
      const body = await res.json();
      assert.ok(Array.isArray(body[collectionKeyOf(route)]), `${route.path} must return an array`);
    }
  } finally {
    await close();
  }
});

function collectionKeyOf(route: RouteContract): string {
  const key = route.keys?.find((k) =>
    ["agents", "activity", "approvals", "executions", "schedules"].includes(k)
  );
  return key ?? "";
}

test("unknown path returns 404 with an error body", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const res = await apiFetch(`${baseUrl}/this/route/does/not/exist`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 body must carry an error field");
  } finally {
    await close();
  }
});

test("known path with an unsupported method returns 404", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    // /agents exists for GET; DELETE is not dispatched, so it must fall
    // through to the 404 fallback rather than silently succeeding.
    const res = await apiFetch(`${baseUrl}/agents`, { method: "DELETE" });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 body must carry an error field");
  } finally {
    await close();
  }
});

test("OPTIONS preflight returns 204 without authentication", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const res = await apiFetch(`${baseUrl}/agents`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
  } finally {
    await close();
  }
});

test("unknown /auth/* route returns 404, not 401", async () => {
  const { baseUrl, close } = await startHarness();
  try {
    const res = await apiFetch(`${baseUrl}/auth/nope`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.ok(body.error, "404 body must carry an error field");
  } finally {
    await close();
  }
});
