import type { CredentialValidationResult, TransitFileStore } from "../../core/types.ts";
import type { ProviderActionHandlerSubset, ProviderFetch } from "../provider-runtime.ts";

import {
  optionalBoolean,
  optionalInteger,
  optionalObjectArray,
  optionalRecord,
  optionalString,
  optionalStringArray,
  recordOrEmpty,
  requiredBoolean,
  stringArray,
} from "../../core/cast.ts";
import { assertPublicHttpUrl, isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  createProviderTimeout,
  providerInputError,
  ProviderRequestError,
  providerUserAgent,
  readProviderJsonBody,
  readTransitFileInput,
  requiredInputString,
} from "../provider-runtime.ts";

const homeBoxCredentialHelpUrl = "https://homebox.software/en/contribute/development/backend/api-handlers/";
export const homeBoxApiPrefix = "api/v1";
const homeBoxTokenExpiryBufferMs = 60_000;
const homeBoxTokenFallbackTtlMs = 5 * 60_000;

export interface HomeBoxActionContext {
  username: string;
  password: string;
  baseUrl: string;
  transitFiles?: TransitFileStore;
  fetcher: typeof fetch;
  signal?: AbortSignal;
}

export type HomeBoxActionHandler = (input: Record<string, unknown>, context: HomeBoxActionContext) => Promise<unknown>;

type HomeBoxQueryValue = string | number | boolean | readonly string[] | undefined;

interface HomeBoxRequestOptions {
  context: HomeBoxActionContext;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, HomeBoxQueryValue>;
  body?: Record<string, unknown> | readonly unknown[] | FormData;
}

interface HomeBoxTokenEntry {
  token: string;
  expiresAt: number;
}

// HomeBox has no API keys: credentials are an email/password pair, and every
// request authenticates with a bearer token obtained from /users/login. Tokens
// are stateful DB sessions that expire after a week (or four with
// stayLoggedIn), so cache them per credential and re-login before expiry.
// In-flight logins are shared so concurrent cold-start requests do not
// exhaust anything (tokens are cheap, but the cache avoids a login per call).
const homeBoxTokenCache = new Map<string, HomeBoxTokenEntry>();
const homeBoxLoginInFlight = new Map<string, Promise<HomeBoxTokenEntry>>();

function homeBoxTokenCacheKey(context: HomeBoxActionContext): string {
  return `${context.baseUrl}|${context.username}|${context.password}`;
}

/** Exposed for the test harness. */
export function clearHomeBoxTokenCache(): void {
  homeBoxTokenCache.clear();
  homeBoxLoginInFlight.clear();
}

export function resolveHomeBoxBaseUrl(input: {
  values?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): string {
  const value = optionalString(input.metadata?.baseUrl) ?? optionalString(input.values?.baseUrl);
  return normalizeHomeBoxBaseUrl(value);
}

function normalizeHomeBoxBaseUrl(
  value: unknown,
  allowPrivateNetwork: boolean = isPrivateNetworkAccessAllowed(),
): string {
  // Private instance targets are allowed only with the deployment opt-in.
  const raw = optionalString(value)?.trim();
  if (!raw) {
    throw new ProviderRequestError(400, "baseUrl is required");
  }

  const url = assertPublicHttpUrl(raw, {
    fieldName: "baseUrl",
    createError: (message) => new ProviderRequestError(400, message),
    allowPrivateNetwork,
  });
  if (url.username || url.password || url.search || url.hash) {
    throw new ProviderRequestError(400, "baseUrl must be a clean instance root URL");
  }

  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  // Users often paste the full API root (https://homebox.local/api) as the
  // instance URL; the API root is appended below it, so drop a trailing
  // /api/v1 or /api segment to avoid double-prefixing every request.
  url.pathname = url.pathname.replace(/\/+(api\/v1|api)$/i, "") || "/";
  return url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
}

function buildHomeBoxUrl(
  context: HomeBoxActionContext,
  path: string,
  query?: Record<string, HomeBoxQueryValue>,
): string {
  const base = `${stripSlashes(context.baseUrl)}/${homeBoxApiPrefix}/`;
  const url = new URL(`./${stripLeadingSlash(path)}`, base);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

interface ExtendedHomeBoxRequestOptions extends HomeBoxRequestOptions {
  token?: string | null;
}

async function performHomeBoxRequest(options: ExtendedHomeBoxRequestOptions): Promise<Response> {
  const { context } = options;
  const url = buildHomeBoxUrl(context, options.path, options.query);
  const headers = new Headers({ accept: "application/json", "user-agent": providerUserAgent });
  if (options.token) {
    headers.set("authorization", options.token);
  }

  let body: BodyInit | undefined;
  if (options.body instanceof FormData) {
    body = options.body;
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }

  const timeout = createProviderTimeout(context.signal);
  try {
    return await context.fetcher(url, {
      method: options.method,
      headers,
      body,
      signal: timeout.signal,
    });
  } catch (error) {
    if (timeout.didTimeout()) {
      throw new ProviderRequestError(504, "HomeBox request timed out");
    }
    throw error;
  } finally {
    timeout.cleanup();
  }
}

async function readHomeBoxPayload(response: Response): Promise<unknown> {
  return readProviderJsonBody(response, {
    emptyBody: null,
    invalidJsonMessage: "HomeBox returned an invalid JSON response",
  });
}

function mapHomeBoxHttpError(status: number, payload: unknown): ProviderRequestError {
  let message: string | undefined;
  if (typeof payload === "string") {
    // Some handlers reply with a plain JSON string, for example failed logins.
    message = payload;
  } else {
    const error = optionalRecord(payload);
    message = optionalString(error?.error) ?? optionalString(error?.message);
  }
  return new ProviderRequestError(status, message ?? `HomeBox request failed with HTTP ${status}`, payload);
}

async function authenticateHomeBox(context: HomeBoxActionContext): Promise<HomeBoxTokenEntry> {
  const response = await performHomeBoxRequest({
    context,
    method: "POST",
    path: "users/login",
    body: { username: context.username, password: context.password, stayLoggedIn: true },
  });
  const payload = await readHomeBoxPayload(response);
  if (!response.ok) {
    // Failed logins are HTTP 500 with a plain JSON string body ("invalid
    // username or password"), not 401; classify them as authorization errors.
    const error = mapHomeBoxHttpError(response.status, payload);
    if (/invalid username or password/i.test(error.message)) {
      throw new ProviderRequestError(401, error.message, payload);
    }
    throw error;
  }
  const token = optionalString(optionalRecord(payload)?.token);
  if (!token) {
    throw new ProviderRequestError(502, "HomeBox login returned no token.");
  }
  const expiresAtIso = optionalString(optionalRecord(payload)?.expiresAt);
  const expiresMs = expiresAtIso ? Date.parse(expiresAtIso) : Number.NaN;
  const ttlMs = Number.isFinite(expiresMs)
    ? Math.max(homeBoxTokenFallbackTtlMs, expiresMs - Date.now() - homeBoxTokenExpiryBufferMs)
    : homeBoxTokenFallbackTtlMs;
  return { token, expiresAt: Date.now() + ttlMs };
}

export async function ensureHomeBoxToken(context: HomeBoxActionContext): Promise<string> {
  const key = homeBoxTokenCacheKey(context);
  const cached = homeBoxTokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.token;
  }

  const inFlight = homeBoxLoginInFlight.get(key);
  if (inFlight) {
    return (await inFlight).token;
  }

  const login = authenticateHomeBox(context)
    .then((entry) => {
      homeBoxTokenCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      homeBoxLoginInFlight.delete(key);
    });
  homeBoxLoginInFlight.set(key, login);
  return (await login).token;
}

async function requestHomeBoxJson(options: HomeBoxRequestOptions): Promise<unknown> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await ensureHomeBoxToken(options.context);
    const response = await performHomeBoxRequest({ ...options, token });
    const payload = await readHomeBoxPayload(response);
    if (response.ok) {
      return payload;
    }
    if (response.status === 401 && attempt === 0) {
      homeBoxTokenCache.delete(homeBoxTokenCacheKey(options.context));
      continue;
    }
    throw mapHomeBoxHttpError(response.status, payload);
  }
  throw new ProviderRequestError(401, "HomeBox rejected the token after re-authentication.");
}

function readPagination(payload: Record<string, unknown>): Record<string, unknown> {
  return {
    items: optionalObjectArray(payload.items, "HomeBox items response") ?? [],
    page: optionalInteger(payload.page) ?? 1,
    pageSize: optionalInteger(payload.pageSize) ?? 0,
    total: optionalInteger(payload.total) ?? 0,
  };
}

export const homeBoxActionHandlers: ProviderActionHandlerSubset<"homebox", HomeBoxActionHandler> = {
  async get_status(_input, context) {
    const payload = recordOrEmpty(await requestHomeBoxJson({ context, method: "GET", path: "status" }));
    return { summary: payload };
  },

  async list_items(input, context) {
    const payload = recordOrEmpty(
      await requestHomeBoxJson({
        context,
        method: "GET",
        path: "items",
        query: {
          q: optionalString(input.q),
          page: optionalInteger(input.page),
          pageSize: optionalInteger(input.pageSize),
          labels: optionalStringArray(input.labelIds),
          locations: optionalStringArray(input.locationIds),
          parentIds: optionalStringArray(input.parentIds),
          includeArchived: optionalBoolean(input.includeArchived),
          orderBy: optionalString(input.orderBy),
        },
      }),
    );
    return readPagination(payload);
  },

  async get_item(input, context) {
    const id = requiredInputString(input.itemId, "itemId");
    const payload = recordOrEmpty(
      await requestHomeBoxJson({ context, method: "GET", path: `items/${encodeURIComponent(id)}` }),
    );
    return { item: payload };
  },

  async create_item(input, context) {
    const name = requiredInputString(input.name, "name");
    const body: Record<string, unknown> = { name };
    const description = optionalString(input.description);
    if (description !== undefined) body.description = description;
    const locationId = optionalString(input.locationId);
    if (locationId) body.locationId = locationId;
    const parentId = optionalString(input.parentId);
    if (parentId) body.parentId = parentId;
    const labelIds = optionalStringArray(input.labelIds);
    if (labelIds !== undefined) body.labelIds = labelIds;
    const payload = recordOrEmpty(await requestHomeBoxJson({ context, method: "POST", path: "items", body }));
    return { item: payload };
  },

  async update_item(input, context) {
    const id = requiredInputString(input.itemId, "itemId");
    // ItemUpdate is a full replacement, so merge the requested changes on top of
    // the current item instead of wiping untouched fields (serial number,
    // warranty, custom fields, ...).
    const current = recordOrEmpty(
      await requestHomeBoxJson({ context, method: "GET", path: `items/${encodeURIComponent(id)}` }),
    );
    const location = optionalRecord(current.location) ?? {};
    const labels = optionalObjectArray(current.labels, "HomeBox item labels response") ?? [];
    const parent = optionalRecord(current.parent) ?? {};

    const body: Record<string, unknown> = {
      name: optionalString(input.name) ?? optionalString(current.name) ?? "",
      // ItemUpdate always sets assetId; omitting it resets the item's asset
      // id to zero, so echo the current one back.
      assetId: optionalString(current.assetId) ?? "",
      description:
        input.description === null
          ? ""
          : (optionalString(input.description) ?? optionalString(current.description) ?? ""),
      quantity: optionalInteger(input.quantity) ?? optionalInteger(current.quantity) ?? 0,
      insured:
        input.insured === undefined
          ? (optionalBoolean(current.insured) ?? false)
          : requiredBoolean(input.insured, "insured", providerInputError),
      archived:
        input.archived === undefined
          ? (optionalBoolean(current.archived) ?? false)
          : requiredBoolean(input.archived, "archived", providerInputError),
      labelIds:
        optionalStringArray(input.labelIds) ??
        labels.map((label) => optionalString(label.id)).filter((labelId): labelId is string => labelId !== undefined),
      serialNumber: optionalString(input.serialNumber) ?? optionalString(current.serialNumber) ?? "",
      modelNumber: optionalString(input.modelNumber) ?? optionalString(current.modelNumber) ?? "",
      manufacturer: optionalString(input.manufacturer) ?? optionalString(current.manufacturer) ?? "",
      lifetimeWarranty:
        input.lifetimeWarranty === undefined
          ? (optionalBoolean(current.lifetimeWarranty) ?? false)
          : requiredBoolean(input.lifetimeWarranty, "lifetimeWarranty", providerInputError),
      warrantyExpires: optionalString(input.warrantyExpires) ?? optionalString(current.warrantyExpires) ?? "",
      warrantyDetails: optionalString(input.warrantyDetails) ?? optionalString(current.warrantyDetails) ?? "",
      purchaseTime: optionalString(input.purchaseTime) ?? optionalString(current.purchaseTime) ?? "",
      purchaseFrom: optionalString(input.purchaseFrom) ?? optionalString(current.purchaseFrom) ?? "",
      purchasePrice: optionalString(input.purchasePrice) ?? optionalString(current.purchasePrice) ?? "0",
      soldTime: optionalString(input.soldTime) ?? optionalString(current.soldTime) ?? "",
      soldTo: optionalString(input.soldTo) ?? optionalString(current.soldTo) ?? "",
      soldPrice: optionalString(input.soldPrice) ?? optionalString(current.soldPrice) ?? "0",
      soldNotes: optionalString(input.soldNotes) ?? optionalString(current.soldNotes) ?? "",
      notes: optionalString(input.notes) ?? optionalString(current.notes) ?? "",
      fields:
        input.fields === undefined
          ? optionalObjectArray(current.fields, "HomeBox custom fields response")
          : optionalObjectArray(input.fields, "HomeBox custom fields input"),
    };
    // Empty UUID strings would fail the adapter's UUID decoding, and the
    // repository clears an unset locationId or parent, so only send ids we
    // actually have.
    const locationId = optionalString(input.locationId) ?? optionalString(location.id);
    if (locationId) {
      body.locationId = locationId;
    }
    const parentId =
      input.parentId === null ? undefined : (optionalString(input.parentId) ?? optionalString(parent.id));
    if (parentId) {
      body.parentId = parentId;
    }
    const payload = recordOrEmpty(
      await requestHomeBoxJson({ context, method: "PUT", path: `items/${encodeURIComponent(id)}`, body }),
    );
    return { item: payload };
  },

  async delete_item(input, context) {
    const id = requiredInputString(input.itemId, "itemId");
    await requestHomeBoxJson({ context, method: "DELETE", path: `items/${encodeURIComponent(id)}` });
    return { deleted: true };
  },

  async list_locations(_input, context) {
    const payload = await requestHomeBoxJson({ context, method: "GET", path: "locations" });
    return { locations: optionalObjectArray(payload, "HomeBox locations response") };
  },

  async create_location(input, context) {
    const name = requiredInputString(input.name, "name");
    const body: Record<string, unknown> = { name };
    const description = optionalString(input.description);
    if (description !== undefined) body.description = description;
    const parentId = optionalString(input.parentId);
    if (parentId) body.parentId = parentId;
    const payload = recordOrEmpty(await requestHomeBoxJson({ context, method: "POST", path: "locations", body }));
    return { location: payload };
  },

  async delete_location(input, context) {
    const id = requiredInputString(input.locationId, "locationId");
    await requestHomeBoxJson({ context, method: "DELETE", path: `locations/${encodeURIComponent(id)}` });
    return { deleted: true };
  },

  async list_labels(_input, context) {
    const payload = await requestHomeBoxJson({ context, method: "GET", path: "labels" });
    return { labels: optionalObjectArray(payload, "HomeBox labels response") };
  },

  async create_label(input, context) {
    const name = requiredInputString(input.name, "name");
    const body: Record<string, unknown> = { name };
    const description = optionalString(input.description);
    if (description !== undefined) body.description = description;
    const color = optionalString(input.color);
    if (color !== undefined) body.color = color;
    const payload = recordOrEmpty(await requestHomeBoxJson({ context, method: "POST", path: "labels", body }));
    return { label: payload };
  },

  async delete_label(input, context) {
    const id = requiredInputString(input.labelId, "labelId");
    await requestHomeBoxJson({ context, method: "DELETE", path: `labels/${encodeURIComponent(id)}` });
    return { deleted: true };
  },

  async get_group_statistics(_input, context) {
    const payload = recordOrEmpty(await requestHomeBoxJson({ context, method: "GET", path: "groups/statistics" }));
    return { statistics: payload };
  },

  async add_item_attachment(input, context) {
    const id = requiredInputString(input.itemId, "itemId");
    const file = await readTransitFileInput(input.file, context);
    const form = new FormData();
    form.append("file", new File([file.file], file.name, { type: file.mimeType ?? "application/octet-stream" }));
    form.append("name", optionalString(input.name) ?? file.name);
    const type = optionalString(input.type);
    if (type !== undefined) {
      form.append("type", type);
    }
    const payload = recordOrEmpty(
      await requestHomeBoxJson({
        context,
        method: "POST",
        path: `items/${encodeURIComponent(id)}/attachments`,
        body: form,
      }),
    );
    return { item: payload };
  },

  async get_maintenance_log(input, context) {
    const id = requiredInputString(input.itemId, "itemId");
    const payload = recordOrEmpty(
      await requestHomeBoxJson({
        context,
        method: "GET",
        path: `items/${encodeURIComponent(id)}/maintenance`,
        query: {
          completed: optionalBoolean(input.completed),
          scheduled: optionalBoolean(input.scheduled),
        },
      }),
    );
    return {
      itemId: optionalString(payload.itemId) ?? id,
      costAverage: payload.costAverage ?? 0,
      costTotal: payload.costTotal ?? 0,
      entries: optionalObjectArray(payload.entries, "HomeBox maintenance log response") ?? [],
    };
  },

  async add_maintenance_entry(input, context) {
    const id = requiredInputString(input.itemId, "itemId");
    const name = requiredInputString(input.name, "name");
    const completedDate = optionalString(input.completedDate);
    const scheduledDate = optionalString(input.scheduledDate);
    if (completedDate === undefined && scheduledDate === undefined) {
      throw providerInputError("Either completedDate or scheduledDate must be set.");
    }
    const body: Record<string, unknown> = { name };
    if (completedDate !== undefined) body.completedDate = completedDate;
    if (scheduledDate !== undefined) body.scheduledDate = scheduledDate;
    const description = optionalString(input.description);
    if (description !== undefined) body.description = description;
    const cost = optionalString(input.cost);
    if (cost !== undefined) body.cost = cost;
    const payload = recordOrEmpty(
      await requestHomeBoxJson({
        context,
        method: "POST",
        path: `items/${encodeURIComponent(id)}/maintenance`,
        body,
      }),
    );
    return { entry: payload };
  },

  async list_custom_field_names(_input, context) {
    const payload = await requestHomeBoxJson({ context, method: "GET", path: "items/fields" });
    return { names: stringArray(payload, "HomeBox custom field names response") };
  },

  async list_custom_field_values(input, context) {
    const field = requiredInputString(input.field, "field");
    const payload = await requestHomeBoxJson({
      context,
      method: "GET",
      path: "items/fields/values",
      query: { field },
    });
    return { values: stringArray(payload, "HomeBox custom field values response") };
  },
};

/**
 * The validator fetcher must already be re-guarded with the same
 * private-network opt-in as the provider executors.
 */
export async function validateHomeBoxCredential(
  input: { apiKey: string; values: Record<string, string> },
  fetcher: ProviderFetch,
  signal?: AbortSignal,
): Promise<CredentialValidationResult> {
  const password = requiredInputString(input.apiKey, "apiKey");
  const username = requiredInputString(input.values.username, "username");
  const baseUrl = normalizeHomeBoxBaseUrl(input.values.baseUrl);

  await authenticateHomeBox({ username, password, baseUrl, fetcher, signal });

  return {
    profile: {
      accountId: `homebox:${baseUrl}`,
      displayName: `HomeBox (${baseUrl})`,
      grantedScopes: [],
    },
    grantedScopes: [],
    metadata: {
      baseUrl,
      credentialHelpUrl: homeBoxCredentialHelpUrl,
    },
  };
}

function stripLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}

function stripSlashes(value: string): string {
  return value.replace(/^\/+/, "").replace(/\/+$/, "");
}
