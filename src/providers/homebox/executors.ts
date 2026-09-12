import type {
  CredentialValidationResult,
  CredentialValidators,
  ExecutionContext,
  ProviderExecutors,
  ProviderProxyExecutor,
} from "../../core/types.ts";
import type { HomeBoxActionContext, HomeBoxActionHandler } from "./runtime.ts";

import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import {
  combineProviderActionHandlers,
  createProviderFetch,
  defineProviderExecutors,
  defineProviderProxy,
  requireApiKeyCredential,
} from "../provider-runtime.ts";
import {
  ensureHomeBoxToken,
  homeBoxActionHandlers,
  homeBoxApiPrefix,
  resolveHomeBoxBaseUrl,
  validateHomeBoxCredential,
} from "./runtime.ts";

const service = "homebox";

function resolveHomeBoxApiRoot(context: ExecutionContext): Promise<string> {
  return requireApiKeyCredential(context, service).then((credential) => {
    const baseUrl = resolveHomeBoxBaseUrl({ values: credential.values, metadata: credential.metadata });
    return `${baseUrl.replace(/\/+$/, "")}/${homeBoxApiPrefix}/`;
  });
}

export const executors: ProviderExecutors = defineProviderExecutors<HomeBoxActionContext>({
  service,
  handlers: combineProviderActionHandlers<"homebox", HomeBoxActionHandler>(service, homeBoxActionHandlers),
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async createContext(context: ExecutionContext, fetcher: typeof fetch): Promise<HomeBoxActionContext> {
    const credential = await requireApiKeyCredential(context, service);
    return {
      username: credential.values.username,
      password: credential.apiKey,
      baseUrl: resolveHomeBoxBaseUrl({ values: credential.values, metadata: credential.metadata }),
      transitFiles: context.transitFiles,
      fetcher,
      signal: context.signal,
    };
  },
});

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: resolveHomeBoxApiRoot,
  // The API authenticates with a per-login bearer token, which cannot be
  // expressed as a static header, so the proxy attaches it during request
  // customization.
  auth: { type: "none" },
  allowPrivateNetwork: isPrivateNetworkAccessAllowed,
  async customizeRequest({ context, headers, fetcher }) {
    const credential = await requireApiKeyCredential(context, service);
    const token = await ensureHomeBoxToken({
      username: credential.values.username,
      password: credential.apiKey,
      baseUrl: resolveHomeBoxBaseUrl({ values: credential.values, metadata: credential.metadata }),
      fetcher,
      signal: context.signal,
    });
    headers.set("authorization", token);
    if (!headers.has("accept")) {
      headers.set("accept", "application/json");
    }
  },
});

export const credentialValidators: CredentialValidators = {
  apiKey(input, { fetcher, signal }): Promise<CredentialValidationResult> {
    // Re-guard the shared validator fetcher with HomeBox's private-network
    // opt-in so validating a private instance baseUrl works when the
    // deployment allows it (createProviderFetch unwraps an already-guarded
    // fetcher).
    const guardedFetcher = createProviderFetch({
      fetch: fetcher,
      allowPrivateNetwork: isPrivateNetworkAccessAllowed,
    });
    return validateHomeBoxCredential(input, guardedFetcher, signal);
  },
};
