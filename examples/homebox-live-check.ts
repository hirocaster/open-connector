/**
 * Live verification of the HomeBox provider against a real instance.
 *
 * Read-only by default; the only mutating check creates and deletes a
 * marker-prefixed location, so repeated runs stay clean.
 *
 * Set HOMEBOX_BASE_URL, HOMEBOX_USERNAME, and HOMEBOX_PASSWORD, then run:
 *
 *   HOMEBOX_BASE_URL=http://homebox.local \
 *   HOMEBOX_USERNAME='admin@example.com' \
 *   HOMEBOX_PASSWORD='...' \
 *   node examples/homebox-live-check.ts
 */
import { setPrivateNetworkAccessAllowed } from "../src/core/request.ts";
import { homeBoxActionHandlers } from "../src/providers/homebox/runtime.ts";
import { createProviderFetch, ProviderRequestError } from "../src/providers/provider-runtime.ts";

const baseUrl = process.env.HOMEBOX_BASE_URL?.trim();
const username = process.env.HOMEBOX_USERNAME?.trim();
const password = process.env.HOMEBOX_PASSWORD?.trim();

const fetcher = createProviderFetch({ allowPrivateNetwork: () => true });
// A HomeBox instance is commonly reachable only on the local network. In
// production the server bootstrap enables this flag from
// OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK; a standalone example has no bootstrap,
// so it opts in explicitly.
setPrivateNetworkAccessAllowed(true);

const context = {
  username: username ?? "",
  password: password ?? "",
  baseUrl: baseUrl ?? "http://homebox.local",
  fetcher,
};

const E2E_MARKER = "connector-e2e";
const createdLocationName = `${E2E_MARKER}-location`;

let failures = 0;
let createdLocationId: string | null = null;

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
    failures += 1;
    console.error(`  ✗ ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main(): Promise<void> {
  if (!baseUrl || !username || !password) {
    console.log("Skip HomeBox live check: set HOMEBOX_BASE_URL, HOMEBOX_USERNAME and HOMEBOX_PASSWORD.");
    return;
  }

  console.log(`[homebox] live check against ${baseUrl}`);

  await step("status", async () => {
    const result = (await homeBoxActionHandlers.get_status?.({}, context)) as { summary: { health?: boolean } };
    check("status is healthy", result.summary.health === true, "health flag is not true");
  });

  await step("list locations", async () => {
    const result = (await homeBoxActionHandlers.list_locations?.({}, context)) as { locations: unknown[] };
    check("location list responds", Array.isArray(result.locations), "no locations array");
  });

  await step("list labels", async () => {
    const result = (await homeBoxActionHandlers.list_labels?.({}, context)) as { labels: unknown[] };
    check("label list responds", Array.isArray(result.labels), "no labels array");
  });

  await step("search items", async () => {
    const result = (await homeBoxActionHandlers.list_items?.({}, context)) as { total: number; items: unknown[] };
    check("item search responds", typeof result.total === "number", "no total");
  });

  await step("custom field names", async () => {
    const result = (await homeBoxActionHandlers.list_custom_field_names?.({}, context)) as { names: string[] };
    check("field names respond", Array.isArray(result.names), "no names array");
  });

  if (!failures) {
    await step("create marker location", async () => {
      const result = (await homeBoxActionHandlers.create_location?.({ name: createdLocationName }, context)) as {
        location: { id: string };
      };
      createdLocationId = result.location.id;
      check(
        "location created",
        typeof createdLocationId === "string" && createdLocationId.length > 0,
        "no location id",
      );
    });

    await step("delete marker location", async () => {
      if (createdLocationId) {
        const result = (await homeBoxActionHandlers.delete_location?.({ locationId: createdLocationId }, context)) as {
          deleted: boolean;
        };
        check("location deleted", result.deleted === true, "deleted flag is not true");
      }
    });
  }

  if (failures > 0) {
    console.error(`[homebox] live check failed: ${failures} check(s) failed.`);
    if (createdLocationId) {
      console.error(`[homebox] leaving ${createdLocationName} (${createdLocationId}) for inspection.`);
    }
    process.exitCode = 1;
  } else {
    console.log("[homebox] live check passed.");
  }
}

// Surface clean provider errors without a stack trace.
void main().catch((error: unknown) => {
  if (error instanceof ProviderRequestError) {
    console.error(`[homebox] live check failed: ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
});
