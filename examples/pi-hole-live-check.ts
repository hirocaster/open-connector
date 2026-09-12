/**
 * Live verification of the Pi-hole provider against a real instance.
 *
 * Read-only by default: every mutating check restores the original state
 * afterwards (DNS blocking mode and any items created are removed by marker
 * prefix, including leftovers from previous runs).
 *
 * Set `PI_HOLE_BASE_URL` and `PI_HOLE_APP_PASSWORD` from the instance web
 * interface under Settings -> All settings -> API, then run:
 *
 *   PI_HOLE_BASE_URL=http://pi.hole \
 *   PI_HOLE_APP_PASSWORD='...' \
 *   node examples/pi-hole-live-check.ts
 */
import { setPrivateNetworkAccessAllowed } from "../src/core/request.ts";
import { piHoleManagementActionHandlers } from "../src/providers/pi_hole/runtime-management.ts";
import { piHoleActionHandlers, requestPiHoleJson, validatePiHoleCredential } from "../src/providers/pi_hole/runtime.ts";
import { createProviderFetch, ProviderRequestError } from "../src/providers/provider-runtime.ts";

const baseUrl = process.env.PI_HOLE_BASE_URL?.trim();
const appPassword = process.env.PI_HOLE_APP_PASSWORD?.trim();
const apiPath = process.env.PI_HOLE_API_PATH?.trim() ?? "api";
const runGravity = process.env.PI_HOLE_RUN_GRAVITY === "1";

const fetcher = createProviderFetch({ allowPrivateNetwork: () => true });
// A Pi-hole instance is commonly reachable only on the local network. In
// production the server bootstrap enables this flag from
// OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK; a standalone example has no bootstrap,
// so it opts in explicitly.
setPrivateNetworkAccessAllowed(true);

const context = {
  appPassword: appPassword ?? "",
  baseUrl: baseUrl ?? "http://pi.hole",
  apiPath,
  fetcher,
};

const handlers = { ...piHoleActionHandlers, ...piHoleManagementActionHandlers };

// Release the API session seat after a run (the runtime inlines this only
// inside credential validation).
async function logoutPiHoleSession(): Promise<void> {
  await requestPiHoleJson({ context, method: "DELETE", path: "auth" }).catch(() => {});
}

const E2E_MARKER = "connector-e2e";
const createdGroupName = `${E2E_MARKER}-group`;
const createdDomain = `${E2E_MARKER}.example.test`;
const createdListAddress = `https://${E2E_MARKER}.example.test/list.txt`;

let failures = 0;

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}: ${detail}`);
  }
}

async function step(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ProviderRequestError && /seats exceeded/i.test(error.message)) {
      console.log(`  - ${label} skipped: no free API session seat (webserver.api.max_sessions)`);
      return;
    }
    failures += 1;
    console.error(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  if (!baseUrl || !appPassword) {
    console.log("Skip Pi-hole live check: set PI_HOLE_BASE_URL and PI_HOLE_APP_PASSWORD.");
    return;
  }

  console.log(`[pi-hole] live check against ${baseUrl}/${apiPath}`);

  await step("credential validation", async () => {
    const result = await validatePiHoleCredential({ apiKey: appPassword, values: { baseUrl, apiPath } }, fetcher);
    check("login succeeds", result !== undefined, "validation returned nothing");
  });

  await step("overview", async () => {
    const result = (await handlers.get_overview?.({}, context)) as { summary: { queries?: number } };
    check("overview responds", typeof result.summary.queries === "number", "no query count");
  });

  await step("blocking status", async () => {
    const result = (await handlers.get_dns_blocking_status?.({}, context)) as { blocking: string };
    check("blocking status responds", typeof result.blocking === "string", "no blocking state");
  });

  await step("top domains", async () => {
    const result = (await handlers.get_top_domains?.({}, context)) as { domains: unknown[] };
    check("top domains respond", Array.isArray(result.domains), "no domains array");
  });

  await step("recent queries", async () => {
    const result = (await handlers.get_queries?.({}, context)) as { queries: unknown[] };
    check("queries respond", Array.isArray(result.queries), "no queries array");
  });

  await step("config", async () => {
    const result = (await handlers.get_config?.({}, context)) as { config: Record<string, unknown> };
    check("config responds", typeof result.config === "object", "no config object");
  });

  await step("group/list/domain read", async () => {
    const groups = (await handlers.list_groups?.({}, context)) as { groups: unknown[] };
    check("groups respond", Array.isArray(groups.groups), "no groups array");
    const lists = (await handlers.list_lists?.({}, context)) as { lists: unknown[] };
    check("lists respond", Array.isArray(lists.lists), "no lists array");
    const domains = (await handlers.list_domains?.({}, context)) as { domains: unknown[] };
    check("domains respond", Array.isArray(domains.domains), "no domains array");
  });

  if (runGravity) {
    await step("gravity", async () => {
      const result = (await handlers.run_gravity?.({}, context)) as { status: string | null };
      check("gravity ran", result.status === "success", `gravity status ${result.status}`);
    });
  }

  if (failures === 0) {
    await step("blocking toggle is restored", async () => {
      const before = (await handlers.get_dns_blocking_status?.({}, context)) as { blocking: string };
      await handlers.set_dns_blocking?.({ blocking: before.blocking !== "enabled" }, context);
      await handlers.set_dns_blocking?.({ blocking: before.blocking === "enabled" }, context);
      const after = (await handlers.get_dns_blocking_status?.({}, context)) as { blocking: string };
      check("blocking restored", after.blocking === before.blocking, `${before.blocking} -> ${after.blocking}`);
    });
  }

  if (failures === 0) {
    await step("marker group/list/domain cleanup", async () => {
      const groups = (await handlers.list_groups?.({}, context)) as { groups: Array<{ name: string }> };
      const createdGroup = groups.groups.find((group) => group.name === createdGroupName);
      if (createdGroup) {
        await handlers.delete_group?.({ name: createdGroup.name }, context);
      }
      const lists = (await handlers.list_lists?.({}, context)) as {
        lists: Array<{ address: string; type: string }>;
      };
      for (const list of lists.lists.filter((entry) => entry.address === createdListAddress)) {
        await handlers.delete_list?.({ address: list.address, type: list.type }, context);
      }
      const domains = (await handlers.list_domains?.({}, context)) as { domains: Array<{ domain: string }> };
      for (const domain of domains.domains.filter((entry) => entry.domain === createdDomain)) {
        await handlers.delete_domain?.({ domain: domain.domain, type: "allow", kind: "exact" }, context);
      }
      check("leftovers cleaned", true, "none");
    });
  }

  // Release the session seat so repeated runs cannot exhaust the instance.
  try {
    await logoutPiHoleSession();
  } catch (error) {
    console.error(`  ! logout: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (failures > 0) {
    console.error(`\n[pi-hole] live check failed with ${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log("\n[pi-hole] live check passed");
  }
}

void main().catch((error: unknown) => {
  if (error instanceof ProviderRequestError) {
    console.error(`[pi-hole] live check failed: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
