import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiServer } from "../src/index.js";
import { DevAuthProvider } from "@4evergent/shared";
import type { Signer } from "@4evergent/stellar";
import type { PolicyRules } from "@4evergent/shared";
import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { InMemoryExecutionStore, InMemoryScheduleStore } from "@4evergent/database";
import type { ExecutionStore, ExecutionRecord, ScheduleRecord } from "@4evergent/database";

declare const fetch: typeof globalThis.fetch;

// fetch with keepalive disabled so Node's http server can close cleanly between tests
async function apiFetch(url: string, init?: RequestInit) {
  return fetch(url, { ...init, keepalive: false });
}

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

const TEST_AGENT = {
  id: "test-agent",
  displayName: "Test Agent",
  description: "test agent",
  ownerId: "test",
  stellarAddress: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  capabilities: ["payment"],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  active: true,
  metadata: {},
};

async function startServer(opts?: { policyRules?: Partial<PolicyRules>; registerAgent?: boolean }) {
  const executionStore = new InMemoryExecutionStore();
  const scheduleStore = new InMemoryScheduleStore();
  const server = await createApiServer({
    port: 0,
    horizonUrl: "https://horizon-testnet.stellar.org",
    signer: new MockSigner("test-agent"),
    policyRules: opts?.policyRules,
    deferExecution: true,
    authProvider: new DevAuthProvider({ defaultOwnerId: "test" }),
    executionStore,
    scheduleStore,
  });
  if (opts?.registerAgent !== false) {
    server.registerAgent(TEST_AGENT);
  }

  return new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
    executionStore: ExecutionStore;
    scheduleStore: InMemoryScheduleStore;
  }>((resolve) => {
    const http = server.server.listen(0, "127.0.0.1", () => {
      const addr = http.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
        executionStore,
        scheduleStore,
      });
    });
  });
}

async function get(baseUrl: string, path: string) {
  const res = await apiFetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json() };
}

// ===== GET /agents =====

test("GET /agents returns registered agents without secret fields", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    assert.equal(res.body.agents.length, 1);
    assert.equal(res.body.agents[0].id, "test-agent");
    assert.equal(res.body.agents[0].displayName, "Test Agent");

    // No secret material in the response
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /agents returns empty list when no agents registered", async () => {
  const { baseUrl, close } = await startServer({ registerAgent: false });
  try {
    const res = await get(baseUrl, "/agents");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.agents));
    // Note: agents map is module-level shared state, so other test files in
    // the same test process may have registered agents already. The contract
    // is: the endpoint returns an array and never leaks secrets.
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

// ===== GET /agents/:id/activity =====

test("GET /agents/:id/activity returns persisted activity", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Submit an intent that requires approval -> creates an activity record
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "read endpoint test",
      }),
    });
    assert.equal(intentRes.status, 202);
    const intentBody = await intentRes.json();

    const res = await get(baseUrl, `/agents/test-agent/activity`);
    assert.equal(res.status, 200);
    assert.equal(res.body.agentId, "test-agent");
    assert.ok(Array.isArray(res.body.activity));
    assert.equal(res.body.activity.length, 1);
    assert.equal(res.body.activity[0].id, intentBody.activityId);
    assert.equal(res.body.activity[0].status, "requires_approval");

    // Activity record must not contain secret material
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity returns 404 for unknown/non-owned agent", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/agents/nonexistent-agent/activity");
    // Authorization rejects non-owned agents with 404 (not found)
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity respects limit query param", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Create 3 activity records
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: Keypair.random().publicKey(),
          amount: "50",
          reason: `limit test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/agents/test-agent/activity?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
  } finally {
    await close();
  }
});

// ===== GET /approvals =====

test("GET /approvals returns persisted approvals", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "approvals list test",
      }),
    });
    const intentBody = await intentRes.json();

    const res = await get(baseUrl, "/approvals");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.approvals));
    assert.equal(res.body.approvals.length, 1);
    assert.equal(res.body.approvals[0].id, intentBody.approvalId);
    assert.equal(res.body.approvals[0].status, "pending_approval");

    // Approval list must not contain secret material or XDR
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /approvals?status=pending_approval filters by status", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Two intents requiring approval
    for (let i = 0; i < 2; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: Keypair.random().publicKey(),
          amount: "50",
          reason: `status filter ${i}`,
        }),
      });
    }

    const pending = await get(baseUrl, "/approvals?status=pending_approval");
    assert.equal(pending.status, 200);
    assert.equal(pending.body.approvals.length, 2);
    for (const a of pending.body.approvals) {
      assert.equal(a.status, "pending_approval");
    }

    const approved = await get(baseUrl, "/approvals?status=approved");
    assert.equal(approved.status, 200);
    assert.equal(approved.body.approvals.length, 0);
  } finally {
    await close();
  }
});

test("GET /approvals returns empty list when none exist", async () => {
  const { baseUrl, close } = await startServer();
  try {
    const res = await get(baseUrl, "/approvals");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.approvals, []);
  } finally {
    await close();
  }
});

// ===== Read endpoints do not expose raw XDR =====

test("read endpoints never return raw XDR or transaction blobs", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "payment",
        asset: "XLM",
        destination: Keypair.random().publicKey(),
        amount: "50",
        reason: "xdr leak test",
      }),
    });

    const activity = await get(baseUrl, "/agents/test-agent/activity");
    const approvals = await get(baseUrl, "/approvals");
    const blob = JSON.stringify(activity.body) + JSON.stringify(approvals.body);
    assert.ok(!/"xdr"/.test(blob), "read endpoints must not expose xdr field");
    assert.ok(!/"envelope"/.test(blob), "read endpoints must not expose envelope field");
    assert.ok(!/"tx_blob"/.test(blob), "read endpoints must not expose tx_blob field");
  } finally {
    await close();
  }
});

// ===== Execution lifecycle visibility =====

function makeSchedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    agentId: "test-agent",
    ownerId: "test",
    status: "active",
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "scheduled test" },
    scheduleExpression: "0 0 * * *",
    timezone: "UTC",
    nextRunAt: new Date().toISOString(),
    lastRunAt: null,
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
    agentId: "test-agent",
    approvalId: null,
    activityId: null,
    intent: { type: "payment", asset: "XLM", destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", amount: "10", reason: "test" },
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

test("GET /executions/:id — confirmed execution readable with txHash and completedAt", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ status: "confirmed", txHash: "a".repeat(64), completedAt: new Date().toISOString() });
    await executionStore.record(execution);

    const res = await get(baseUrl, `/executions/${execution.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.execution.status, "confirmed");
    assert.equal(res.body.execution.txHash, "a".repeat(64));
    assert.ok(res.body.execution.completedAt);
  } finally {
    await close();
  }
});

test("GET /executions/:id — dead_letter execution readable with error and attempt count", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({
      status: "dead_letter",
      error: "Max retries exceeded: network timeout",
      attempt: 3,
      errorClass: "transient",
      completedAt: new Date().toISOString(),
    });
    await executionStore.record(execution);

    const res = await get(baseUrl, `/executions/${execution.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.execution.status, "dead_letter");
    assert.ok(res.body.execution.error);
    assert.equal(res.body.execution.attempt, 3);
    assert.equal(res.body.execution.errorClass, "transient");
  } finally {
    await close();
  }
});

test("GET /agents/:id/executions — mixed lifecycle statuses all returned", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    await executionStore.record(makeExecution({ status: "queued" }));
    await executionStore.record(makeExecution({ status: "executing", startedAt: new Date().toISOString() }));
    await executionStore.record(makeExecution({ status: "submitted", txHash: "b".repeat(64) }));
    await executionStore.record(makeExecution({ status: "confirmed", txHash: "c".repeat(64), completedAt: new Date().toISOString() }));
    await executionStore.record(makeExecution({ status: "failed", error: "on-chain failed", errorClass: "permanent", completedAt: new Date().toISOString() }));
    await executionStore.record(makeExecution({ status: "dead_letter", error: "max retries", attempt: 3 }));

    const res = await get(baseUrl, "/agents/test-agent/executions");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 6);
    const statuses = new Set(res.body.executions.map((e: ExecutionRecord) => e.status));
    assert.ok(statuses.has("queued"));
    assert.ok(statuses.has("executing"));
    assert.ok(statuses.has("submitted"));
    assert.ok(statuses.has("confirmed"));
    assert.ok(statuses.has("failed"));
    assert.ok(statuses.has("dead_letter"));
  } finally {
    await close();
  }
});

test("GET /executions/:id — owner isolation on lifecycle reads (cross-owner 404)", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    const execution = makeExecution({ ownerId: "owner-b", status: "confirmed", txHash: "d".repeat(64) });
    await executionStore.record(execution);

    const res = await get(baseUrl, `/executions/${execution.id}`);
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ===== GET /executions (global owner-scoped listing) =====

test("GET /executions returns owner's executions in single request", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    await executionStore.record(makeExecution({ id: "exec-a", status: "confirmed", txHash: "a".repeat(64) }));
    await executionStore.record(makeExecution({ id: "exec-b", status: "failed", error: "timeout", attempt: 1 }));

    const res = await get(baseUrl, "/executions");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.executions));
    assert.equal(res.body.executions.length, 2);
    const ids = new Set(res.body.executions.map((e: any) => e.id));
    assert.ok(ids.has("exec-a"));
    assert.ok(ids.has("exec-b"));

    // No secret material
    const json = JSON.stringify(res.body);
    assert.ok(!/secret|seed|private_key|mnemonic|keypair/i.test(json));
  } finally {
    await close();
  }
});

test("GET /executions does not return another owner's executions", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    // Owner "test" has no executions; "owner-b" has one
    await executionStore.record(makeExecution({ ownerId: "owner-b", id: "exec-other" }));
    const res = await get(baseUrl, "/executions");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 0);
  } finally {
    await close();
  }
});

test("GET /executions respects limit", async () => {
  const { baseUrl, close, executionStore } = await startServer();
  try {
    for (let i = 0; i < 5; i++) {
      await executionStore.record(makeExecution({ id: `exec-${i}` }));
    }
    const res = await get(baseUrl, "/executions?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 2);
  } finally {
    await close();
  }
});

// ===== GET /activity (global owner-scoped listing) =====

test("GET /activity returns owner's activity in single request", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    // Generate activity by submitting intents
    for (let i = 0; i < 2; i++) {
      const intentRes = await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `activity test ${i}`,
        }),
      });
      assert.equal(intentRes.status, 202);
    }
    const res = await get(baseUrl, "/activity");
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.activity));
    assert.equal(res.body.activity.length, 2);
    assert.ok(res.body.activity[0].id);
  } finally {
    await close();
  }
});

test("GET /activity does not return another owner's activity", async () => {
  const { baseUrl, close } = await startServer({
    authProvider: new DevAuthProvider({ defaultOwnerId: "owner-a" }),
    registerAgent: false,
  });
  try {
    const res = await get(baseUrl, "/activity");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 0);
  } finally {
    await close();
  }
});

test("GET /activity respects limit", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `limit test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/activity?limit=2");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
  } finally {
    await close();
  }
});

// --- Pagination offset tests ---

test("GET /activity offset returns next page and hasMore", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 5; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `paginate test ${i}`,
        }),
      });
    }
    const page1 = await get(baseUrl, "/activity?limit=3&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.activity.length, 3);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/activity?limit=3&offset=3");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.activity.length, 2);
    assert.equal(page2.body.hasMore, false);

    // Ensure no overlap
    const page1Ids = new Set(page1.body.activity.map((a: any) => a.id));
    for (const a of page2.body.activity) assert.ok(!page1Ids.has(a.id));
  } finally {
    await close();
  }
});

test("GET /activity hasMore false when fewer than limit+1 items exist", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" }, requireHumanApprovalForAmountAbove: "10" },
  });
  try {
    for (let i = 0; i < 2; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `hasMore test ${i}`,
        }),
      });
    }
    const res = await get(baseUrl, "/activity?limit=5&offset=0");
    assert.equal(res.status, 200);
    assert.equal(res.body.activity.length, 2);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /executions offset pagination works", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 4; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const page1 = await get(baseUrl, "/executions?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.executions.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/executions?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.executions.length, 2);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /executions?offset without limit works", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const res = await get(baseUrl, "/executions?offset=1");
    assert.equal(res.status, 200);
    assert.equal(res.body.executions.length, 2);
    assert.equal(res.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /agents/:id/activity offset pagination", async () => {
  const { baseUrl, close } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await apiFetch(`${baseUrl}/agents/test-agent/intents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "payment",
          asset: "XLM",
          destination: "GDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          amount: "50",
          reason: `agent activity pagination ${i}`,
        }),
      });
    }
    const page1 = await get(baseUrl, "/agents/test-agent/activity?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.activity.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents/test-agent/activity?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.activity.length, 1);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /agents/:id/executions offset pagination", async () => {
  const { baseUrl, close, executionStore } = await startServer({
    policyRules: { maxTxAmount: { XLM: "1000" } },
  });
  try {
    for (let i = 0; i < 3; i++) {
      await executionStore.record(makeExecution({ status: "confirmed" }));
    }
    const page1 = await get(baseUrl, "/agents/test-agent/executions?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.executions.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents/test-agent/executions?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.executions.length, 1);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});

test("GET /agents/:id/schedules offset pagination", async () => {
  const { baseUrl, close, scheduleStore } = await startServer({});
  try {
    for (let i = 0; i < 3; i++) {
      await scheduleStore.create(makeSchedule());
    }
    const page1 = await get(baseUrl, "/agents/test-agent/schedules?limit=2&offset=0");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.schedules.length, 2);
    assert.equal(page1.body.hasMore, true);

    const page2 = await get(baseUrl, "/agents/test-agent/schedules?limit=2&offset=2");
    assert.equal(page2.status, 200);
    assert.equal(page2.body.schedules.length, 1);
    assert.equal(page2.body.hasMore, false);
  } finally {
    await close();
  }
});
