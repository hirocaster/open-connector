import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { setPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { executors } from "./executors.ts";

const lanInstanceUrl = "http://192.168.150.53:7745";
const apiKey = "hb_static_test_key";

function executionContext(): ExecutionContext {
  const credential: Extract<ResolvedCredential, { authType: "api_key" }> = {
    authType: "api_key",
    apiKey,
    values: { baseUrl: lanInstanceUrl },
    profile: { accountId: "homebox:test", displayName: "HomeBox test", grantedScopes: [] },
    metadata: {},
  };
  return { getCredential: async () => credential };
}

describe("homebox remove_entity_attachment", () => {
  it("deletes the attachment via the entity attachments route with the bearer key", async () => {
    setPrivateNetworkAccessAllowed(true);
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "192.168.150.53", family: 4 }]);

    const calls: { url: string; method: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        calls.push({
          url: url.toString(),
          method: init?.method ?? "GET",
          auth: new Headers(init?.headers).get("authorization"),
        });
        return new Response(null, { status: 204 });
      }),
    );

    try {
      const result = await executors["homebox.remove_entity_attachment"]!(
        { entityId: "entity-1", attachmentId: "attachment-2" },
        executionContext(),
      );
      if (!result.ok) {
        throw new Error(`expected delete success, got: ${result.error?.message}`);
      }
      expect(result.output).toEqual({ deleted: true });
    } finally {
      setDefaultGuardedFetchDnsLookup(null);
      setPrivateNetworkAccessAllowed(false);
      vi.unstubAllGlobals();
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "DELETE",
      url: `${lanInstanceUrl}/api/v1/entities/entity-1/attachments/attachment-2`,
      auth: `Bearer ${apiKey}`,
    });
  });
});
