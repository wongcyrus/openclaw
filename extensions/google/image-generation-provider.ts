// Google provider module implements model/runtime integration.
import {
  generatedImageAssetFromBase64,
  type GeneratedImageAsset,
  type ImageGenerationProvider,
} from "openclaw/plugin-sdk/image-generation";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { isProviderApiKeyConfigured } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  assertOkOrThrowHttpError,
  postJsonRequest,
  sanitizeConfiguredModelProviderRequest,
  resolveProviderHttpRequestConfig,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  isRecord,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_GOOGLE_API_BASE_URL,
  normalizeGoogleApiBaseUrl,
  normalizeGoogleModelId,
  parseGeminiAuth,
} from "./api.js";

const DEFAULT_GOOGLE_IMAGE_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_IMAGE_TIMEOUT_MS = 180_000;
const DEFAULT_OUTPUT_MIME = "image/png";
const GOOGLE_SUPPORTED_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "1024x1792",
  "1792x1024",
] as const;
const GOOGLE_SUPPORTED_ASPECT_RATIOS = [
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
] as const;

const GOOGLE_IMAGE_MALFORMED_RESPONSE = "Google image generation response malformed";

/**
 * Browser-safe environment variable reader.
 */
function readProviderEnvValue(envVars: string[]): string | undefined {
  const env = typeof process !== "undefined" ? process.env : undefined;
  if (!env) {
    return undefined;
  }
  for (const envVar of envVars) {
    const value = normalizeSecretInput(env[envVar]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

type OpenAICompatibleImageResponse = {
  data?: Array<{
    b64_json?: string;
    url?: string;
  }>;
  error?: {
    message?: string;
  };
};

function resolveGoogleBaseUrl(cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"]): string {
  const fromConfig = (cfg?.models?.providers?.google as { baseUrl?: string } | undefined)?.baseUrl;
  const fromEnv = readProviderEnvValue([
    "GOOGLE_GEMINI_ENDPOINT",
    "GEMINI_BASE_URL",
    "GOOGLE_GEMINI_BASE_URL",
  ]);
  return normalizeGoogleApiBaseUrl(fromConfig || fromEnv);
}

function resolveGoogleApiType(
  cfg: Parameters<typeof resolveApiKeyForProvider>[0]["cfg"],
): "gemini" | "openai-compatible" {
  const configuredApiType = (cfg?.models?.providers?.google as { apiType?: string } | undefined)
    ?.apiType;
  const envApiType = readProviderEnvValue(["GEMINI_API_TYPE"]);

  if (configuredApiType === "openai-compatible" || envApiType === "openai-compatible") {
    return "openai-compatible";
  }

  const baseUrl = resolveGoogleBaseUrl(cfg);
  if (
    !baseUrl.includes("googleapis.com") &&
    (baseUrl.endsWith("/v1") || baseUrl.includes("/v1/"))
  ) {
    return "openai-compatible";
  }

  return "gemini";
}

function normalizeGoogleImageModel(model: string | undefined): string {
  const trimmed = model?.trim();
  return normalizeGoogleModelId(trimmed || DEFAULT_GOOGLE_IMAGE_MODEL);
}

function mapSizeToImageConfig(
  size: string | undefined,
): { aspectRatio?: string; imageSize?: "2K" | "4K" } | undefined {
  const trimmed = size?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = normalizeLowercaseStringOrEmpty(trimmed);
  const mapping = new Map<string, string>([
    ["1024x1024", "1:1"],
    ["1024x1536", "2:3"],
    ["1536x1024", "3:2"],
    ["1024x1792", "9:16"],
    ["1792x1024", "16:9"],
  ]);
  const aspectRatio = mapping.get(normalized);

  const [widthRaw, heightRaw] = normalized.split("x");
  const width = parseStrictPositiveInteger(widthRaw);
  const height = parseStrictPositiveInteger(heightRaw);
  if (width === undefined || height === undefined) {
    return undefined;
  }
  const longestEdge = Math.max(width, height);
  const imageSize = longestEdge >= 3072 ? "4K" : longestEdge >= 1536 ? "2K" : undefined;

  if (!aspectRatio && !imageSize) {
    return undefined;
  }

  return {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {}),
  };
}

function googleResponseParts(payload: unknown): unknown[] {
  if (!isRecord(payload)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  const candidates = payload.candidates;
  if (candidates === undefined || candidates === null) {
    return [];
  }
  if (!Array.isArray(candidates)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }

  const parts: unknown[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const content = candidate.content;
    if (content === undefined || content === null) {
      continue;
    }
    if (!isRecord(content)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    const candidateParts = content.parts;
    if (candidateParts === undefined || candidateParts === null) {
      continue;
    }
    if (!Array.isArray(candidateParts)) {
      throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
    }
    parts.push(...candidateParts);
  }
  return parts;
}

function googleInlineDataFromPart(part: unknown): Record<string, unknown> | undefined {
  if (!isRecord(part)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  const inline = part.inlineData ?? part.inline_data;
  if (inline === undefined || inline === null) {
    return undefined;
  }
  if (!isRecord(inline)) {
    throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
  }
  return inline;
}

export function buildGoogleImageGenerationProvider(): ImageGenerationProvider {
  return {
    id: "google",
    label: "Google",
    defaultModel: DEFAULT_GOOGLE_IMAGE_MODEL,
    models: [DEFAULT_GOOGLE_IMAGE_MODEL, "gemini-3-pro-image-preview"],
    isConfigured: ({ agentDir }) =>
      isProviderApiKeyConfigured({
        provider: "google",
        agentDir,
      }),
    capabilities: {
      generate: {
        maxCount: 4,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      edit: {
        enabled: true,
        maxCount: 4,
        maxInputImages: 5,
        supportsSize: true,
        supportsAspectRatio: true,
        supportsResolution: true,
      },
      geometry: {
        sizes: [...GOOGLE_SUPPORTED_SIZES],
        aspectRatios: [...GOOGLE_SUPPORTED_ASPECT_RATIOS],
        resolutions: ["1K", "2K", "4K"],
      },
    },
    async generateImage(req) {
      const auth = await resolveApiKeyForProvider({
        provider: "google",
        cfg: req.cfg,
        agentDir: req.agentDir,
        store: req.authStore,
      });
      if (!auth.apiKey) {
        throw new Error("Google API key missing");
      }

      const model = normalizeGoogleImageModel(req.model);
      const apiType = resolveGoogleApiType(req.cfg);
      const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } =
        resolveProviderHttpRequestConfig({
          baseUrl: resolveGoogleBaseUrl(req.cfg),
          defaultBaseUrl: DEFAULT_GOOGLE_API_BASE_URL,
          allowPrivateNetwork: true,
          defaultHeaders: parseGeminiAuth(auth.apiKey).headers,
          provider: "google",
          api: "google-generative-ai",
          capability: "image",
          transport: "http",
          request: sanitizeConfiguredModelProviderRequest(
            req.cfg?.models?.providers?.google?.request,
          ),
        });

      let resolvedBaseUrl = baseUrl;
      if (apiType === "gemini" && resolvedBaseUrl.endsWith("/openai")) {
        resolvedBaseUrl = resolvedBaseUrl.replace(/\/openai$/, "");
      }

      if (apiType === "openai-compatible") {
        const endpoint = `${resolvedBaseUrl.replace(/\/$/, "")}/images/generations`;
        // We omit response_format: "b64_json" because LiteLLM Proxy for Gemini doesn't support it.
        const requestHeaders = new Headers(headers);
        requestHeaders.set("Authorization", `Bearer ${auth.apiKey}`);

        const { response: res, release } = await postJsonRequest({
          url: endpoint,
          headers: requestHeaders,
          body: {
            model,
            prompt: req.prompt,
            n: req.count ?? 1,
            size: req.size ?? "1024x1024",
          },
          timeoutMs: req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
          fetchFn: fetch,
          pinDns: false,
          allowPrivateNetwork,
          ssrfPolicy: req.ssrfPolicy,
          dispatcherPolicy,
        });

        try {
          await assertOkOrThrowHttpError(res, "Google image generation failed (OpenAI-compatible)");
          const payload = (await res.json()) as OpenAICompatibleImageResponse;
          const images = await Promise.all(
            (payload.data ?? []).map(async (item, index) => {
              if (item.b64_json) {
                return {
                  buffer: Buffer.from(item.b64_json, "base64"),
                  mimeType: DEFAULT_OUTPUT_MIME,
                  fileName: `image-${index + 1}.png`,
                };
              } else if (item.url) {
                const imgRes = await fetch(item.url);
                if (!imgRes.ok) {
                  return null;
                }
                const buffer = Buffer.from(await imgRes.arrayBuffer());
                const mimeType = imgRes.headers.get("content-type") || DEFAULT_OUTPUT_MIME;
                const extension = mimeType.includes("jpeg")
                  ? "jpg"
                  : (mimeType.split("/")[1] ?? "png");
                return {
                  buffer,
                  mimeType,
                  fileName: `image-${index + 1}.${extension}`,
                };
              }
              return null;
            }),
          );

          const filteredImages = images.filter(
            (img): img is NonNullable<typeof img> => img !== null,
          );

          if (filteredImages.length === 0) {
            throw new Error("Google image generation response missing image data");
          }
          return { images: filteredImages, model };
        } finally {
          await release();
        }
      }
      const imageConfig = mapSizeToImageConfig(req.size);
      const inputParts = (req.inputImages ?? []).map((image) => ({
        inlineData: {
          mimeType: image.mimeType,
          data: image.buffer.toString("base64"),
        },
      }));
      const resolvedImageConfig = {
        ...imageConfig,
        ...(req.aspectRatio?.trim() ? { aspectRatio: req.aspectRatio.trim() } : {}),
        ...(req.resolution ? { imageSize: req.resolution } : {}),
      };

      const { response: res, release } = await postJsonRequest({
        url: `${resolvedBaseUrl}/models/${model}:generateContent`,
        headers,
        body: {
          contents: [
            {
              role: "user",
              parts: [...inputParts, { text: req.prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ["TEXT", "IMAGE"],
            ...(Object.keys(resolvedImageConfig).length > 0
              ? { imageConfig: resolvedImageConfig }
              : {}),
          },
        },
        timeoutMs: req.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS,
        fetchFn: fetch,
        pinDns: false,
        allowPrivateNetwork,
        ssrfPolicy: req.ssrfPolicy,
        dispatcherPolicy,
      });

      try {
        await assertOkOrThrowHttpError(res, "Google image generation failed");

        const payload = await res.json();
        let imageIndex = 0;
        const images: GeneratedImageAsset[] = [];
        for (const part of googleResponseParts(payload)) {
          const inline = googleInlineDataFromPart(part);
          if (!inline) {
            continue;
          }
          const data = normalizeOptionalString(inline.data);
          if (!data) {
            throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
          }
          const image = generatedImageAssetFromBase64({
            base64: data,
            index: imageIndex,
            mimeType:
              normalizeOptionalString(inline.mimeType) ??
              normalizeOptionalString(inline.mime_type) ??
              DEFAULT_OUTPUT_MIME,
          });
          if (!image) {
            throw new Error(GOOGLE_IMAGE_MALFORMED_RESPONSE);
          }
          imageIndex += 1;
          images.push(image);
        }

        if (images.length === 0) {
          throw new Error("Google image generation response missing image data");
        }

        return {
          images,
          model,
        };
      } finally {
        await release();
      }
    },
  };
}
