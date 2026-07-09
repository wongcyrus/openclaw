import { readProviderEnvValue } from "openclaw/plugin-sdk/provider-web-search";
// Google provider module implements model/runtime integration.
import {
  isRecord,
  normalizeOptionalString as trimToUndefined,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeGoogleApiBaseUrl } from "../provider-policy.js";

const DEFAULT_GEMINI_WEB_SEARCH_MODEL = "gemini-2.5-flash";

export type GeminiConfig = {
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  apiType?: unknown;
  providerApiKey?: unknown;
  providerBaseUrl?: unknown;
};

export function resolveGeminiConfig(searchConfig?: Record<string, unknown>): GeminiConfig {
  const gemini = searchConfig?.gemini;
  return isRecord(gemini) ? gemini : {};
}

export function resolveGeminiApiKey(
  gemini?: GeminiConfig,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    trimToUndefined(gemini?.apiKey) ??
    trimToUndefined(env.GEMINI_API_KEY) ??
    trimToUndefined(env.GOOGLE_API_KEY) ??
    trimToUndefined(gemini?.providerApiKey)
  );
}

export function resolveGeminiModel(gemini?: GeminiConfig): string {
  return trimToUndefined(gemini?.model) ?? DEFAULT_GEMINI_WEB_SEARCH_MODEL;
}

export function resolveGeminiBaseUrl(gemini?: GeminiConfig): string {
  const fromConfig = trimToUndefined(gemini?.baseUrl) ?? trimToUndefined(gemini?.providerBaseUrl);
  const fromEnv = readProviderEnvValue([
    "GOOGLE_GEMINI_ENDPOINT",
    "GEMINI_BASE_URL",
    "GOOGLE_GEMINI_BASE_URL",
  ]);
  return normalizeGoogleApiBaseUrl(fromConfig ?? fromEnv);
}

export function resolveGeminiApiType(gemini?: GeminiConfig): "gemini" | "openai-compatible" {
  const apiType = trimToUndefined(gemini?.apiType);
  if (apiType === "openai-compatible" || apiType === "gemini") {
    return apiType;
  }
  const fromEnv = readProviderEnvValue(["GEMINI_API_TYPE"]);
  if (fromEnv === "openai-compatible" || fromEnv === "gemini") {
    return fromEnv;
  }

  // Robust fallback: if baseUrl contains /v1 and is NOT googleapis.com, it's likely OpenAI-compatible
  const baseUrl = resolveGeminiBaseUrl(gemini);
  if (
    baseUrl &&
    !baseUrl.includes("googleapis.com") &&
    (baseUrl.endsWith("/v1") || baseUrl.includes("/v1/"))
  ) {
    return "openai-compatible";
  }
  return "gemini";
}
