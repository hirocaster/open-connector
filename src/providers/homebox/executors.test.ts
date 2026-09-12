import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { executors, proxy } from "./executors.ts";
import { clearHomeBoxTokenCache } from "./runtime.ts";

// Arbitrary RFC1918 literal: the tests only exercise the private-network opt-in,
// and every fetch and DNS lookup is stubbed, so this never touches a real host.
const lanInstanceUrl = "http://192.168.150.53:7745";

function apiKeyCredential(): Extract<ResolvedCredential, { authType: "api_key" }> {
  return {
    authType: "api_key",
    apiKey: "hunter2",
    values: { username: "admin@example.com", baseUrl: lanInstanceUrl },
    profile: { accountId: "homebox:test", displayName: "HomeBox test", grantedScopes: [] },
    metadata: {},
  };
}

function executionContext(): ExecutionContext {
  const credential = apiKeyCredential();
  return { getCredential: async () => credential };
}

function loginResponse(token: string): Response {
  return Response.json({
    token: `Bearer ${token}`,
    expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    attachmentToken: "attachment-token",
  });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

describe("homebox provider", () => {
  afterEach(() => {
    setDefaultGuardedFetchDnsLookup(null);
    setPrivateNetworkAccessAllowed(false);
    clearHomeBoxTokenCache();
    vi.unstubAllGlobals();
  });

  it("logs in with username/password and proxies a token-authenticated request", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async (hostname) => [
      { address: hostname === "192.168.150.53" ? "192.168.150.53" : "93.184.216.34", family: 4 },
    ]);

    const requests: CapturedRequest[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      requests.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        headers,
        body: init?.body ? String(init?.body) : undefined,
      });
      if (url.pathname === "/api/v1/users/login") {
        return loginResponse("token-1");
      }
      if (url.pathname === "/api/v1/entities") {
        return Response.json({ page: 1, pageSize: 10, total: 1, items: [{ id: "entity-1", name: "Laptop" }] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await proxy({ method: "GET", endpoint: "/entities" }, executionContext());
    if (!result.ok) {
      throw new Error(`expected proxy success, got: ${result.error.message}`);
    }
    expect(result.response.status).toBe(200);

    const loginCall = requests.find((request) => request.url.endsWith("/api/v1/users/login"))!;
    expect(loginCall.method).toBe("POST");
    expect(JSON.parse(loginCall.body ?? "{}")).toEqual({
      username: "admin@example.com",
      password: "hunter2",
      stayLoggedIn: true,
    });

    const entitiesCall = requests.find((request) => request.url.endsWith("/api/v1/entities"))!;
    expect(entitiesCall.url).toBe(`${lanInstanceUrl}/api/v1/entities`);
    expect(entitiesCall.headers.get("authorization")).toBe("Bearer token-1");
  });

  it("re-authenticates and retries once when the cached token is rejected", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async (hostname) => [
      { address: hostname === "192.168.150.53" ? "192.168.150.53" : "93.184.216.34", family: 4 },
    ]);

    let logins = 0;
    let entityCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/v1/users/login") {
        logins += 1;
        return loginResponse(logins === 1 ? "expired-token" : "fresh-token");
      }
      if (url.pathname === "/api/v1/entities") {
        entityCalls += 1;
        if (entityCalls === 1) {
          return new Response(JSON.stringify({ error: "valid authorization token is required" }), { status: 401 });
        }
        return Response.json({ page: 1, pageSize: 10, total: 0, items: [] });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executors["homebox.list_entities"]!({}, executionContext());
    if (!result.ok) {
      throw new Error(`expected executor success, got: ${result.error?.message}`);
    }
    expect(result.output).toMatchObject({ page: 1, total: 0 });
    expect(logins).toBe(2);
    expect(entityCalls).toBe(2);
  });

  it("rejects a LAN instance without the private-network opt-in", async () => {
    setDefaultGuardedFetchDnsLookup(async (hostname) => [
      { address: hostname === "192.168.150.53" ? "192.168.150.53" : "93.184.216.34", family: 4 },
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await proxy({ method: "GET", endpoint: "/entities" }, executionContext());

    if (result.ok) {
      throw new Error("expected proxy to reject the LAN base URL");
    }
    expect(result.error.message).toContain("private or reserved IP addresses");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports missing credentials as an explicit 401", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);
    vi.stubGlobal("fetch", vi.fn());

    const result = await proxy({ method: "GET", endpoint: "/entities" }, { getCredential: async () => undefined });

    if (result.ok) {
      throw new Error("expected proxy to reject missing credentials");
    }
    expect(result.error.message).toContain("Configure homebox API key credentials first.");
  });

  it("merges update_entity on top of the current entity and preserves assetId and custom fields", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);

    const requests: CapturedRequest[] = [];
    const entity = {
      id: "entity-1",
      name: "Laptop",
      description: "ThinkPad",
      quantity: 1,
      insured: false,
      archived: false,
      assetId: "003-042",
      serialNumber: "SN-1",
      modelNumber: "X1",
      manufacturer: "Lenovo",
      purchasePrice: 1200,
      entityType: { id: "type-1", name: "Electronics" },
      parent: { id: "parent-1", name: "Desk" },
      tags: [{ id: "tag-1", name: "Computers" }],
      fields: [{ id: "field-1", type: "text", name: "Color", textValue: "black", numberValue: 0, booleanValue: false }],
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const headers = new Headers(init?.headers);
      requests.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        headers,
        body: init?.body ? String(init?.body) : undefined,
      });
      if (url.pathname === "/api/v1/users/login") {
        return loginResponse("token-1");
      }
      if (url.pathname === "/api/v1/entities/entity-1" && (init?.method ?? "GET") === "GET") {
        return Response.json(entity);
      }
      if (url.pathname === "/api/v1/entities/entity-1" && init?.method === "PUT") {
        return Response.json({ ...entity, quantity: 5 });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executors["homebox.update_entity"]!({ entityId: "entity-1", quantity: 5 }, executionContext());
    if (!result.ok) {
      throw new Error(`expected update success, got: ${result.error?.message}`);
    }

    const putCall = requests.find((request) => request.method === "PUT")!;
    const body = JSON.parse(putCall.body ?? "{}") as Record<string, unknown>;
    expect(body.quantity).toBe(5);
    expect(body.assetId).toBe("003-042");
    expect(body.serialNumber).toBe("SN-1");
    expect(body.manufacturer).toBe("Lenovo");
    expect(body.purchasePrice).toBe(1200);
    expect(body.entityTypeId).toBe("type-1");
    expect(body.parentId).toBe("parent-1");
    expect(body.tagIds).toEqual(["tag-1"]);
    expect(body.fields).toEqual(entity.fields);
  });

  it("maps a failed login to an authorization error", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname === "/api/v1/users/login") {
        return new Response(JSON.stringify("invalid username or password"), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await executors["homebox.get_status"]!({}, executionContext());
    if (result.ok) {
      throw new Error("expected login to fail");
    }
    expect(result.error?.code).toBe("authorization_failed");
    expect(result.error?.message).toContain("invalid username or password");
  });

  it("encodes list_entities filter parameters as repeated multi-value query params", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);
    const requests: CapturedRequest[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        requests.push({ url: url.toString(), method: init?.method ?? "GET", headers: new Headers(init?.headers) });
        if (url.pathname === "/api/v1/users/login") {
          return loginResponse("token-1");
        }
        if (url.pathname === "/api/v1/entities") {
          return Response.json({ page: 1, pageSize: 10, total: 0, items: [] });
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await executors["homebox.list_entities"]!({ q: "laptop", tagIds: ["a", "b"] }, executionContext());
    if (!result.ok) {
      throw new Error(`expected list success, got: ${result.error?.message}`);
    }

    const entitiesCall = requests.find((request) => new URL(request.url).pathname === "/api/v1/entities")!;
    const url = new URL(entitiesCall.url);
    expect(url.searchParams.get("q")).toBe("laptop");
    expect(url.searchParams.getAll("tags")).toEqual(["a", "b"]);
  });

  it("rejects a maintenance entry without either date", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await executors["homebox.add_maintenance_entry"]!(
      { entityId: "entity-1", name: "Oil change" },
      executionContext(),
    );
    if (result.ok) {
      throw new Error("expected maintenance validation to fail");
    }
    expect(result.error?.code).toBe("invalid_input");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads the custom field names plain array response", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === "/api/v1/users/login") {
          return loginResponse("token-1");
        }
        if (url.pathname === "/api/v1/entities/fields") {
          return Response.json(["Color", "Serial"]);
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const result = await executors["homebox.list_custom_field_names"]!({}, executionContext());
    if (!result.ok) {
      throw new Error(`expected field names, got: ${result.error?.message}`);
    }
    expect(result.output).toEqual({ names: ["Color", "Serial"] });
  });

  it("reads the plain array responses of list_entity_types and list_tags", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname === "/api/v1/users/login") {
          return loginResponse("token-1");
        }
        if (url.pathname === "/api/v1/entity-types") {
          return Response.json([{ id: "type-1", name: "Location", isLocation: true }]);
        }
        if (url.pathname === "/api/v1/tags") {
          return Response.json([{ id: "tag-1", name: "Electronics" }]);
        }
        return new Response("not found", { status: 404 });
      }),
    );

    const entityTypes = await executors["homebox.list_entity_types"]!({}, executionContext());
    if (!entityTypes.ok) {
      throw new Error(`expected entity types, got: ${entityTypes.error?.message}`);
    }
    expect(entityTypes.output).toEqual({ entityTypes: [{ id: "type-1", name: "Location", isLocation: true }] });

    const tags = await executors["homebox.list_tags"]!({}, executionContext());
    if (!tags.ok) {
      throw new Error(`expected tags, got: ${tags.error?.message}`);
    }
    expect(tags.output).toEqual({ tags: [{ id: "tag-1", name: "Electronics" }] });
  });
});
