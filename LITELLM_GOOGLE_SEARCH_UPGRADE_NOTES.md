# Upgrading OpenClaw: LiteLLM Google Search Grounding Proxy Fixes

When upgrading OpenClaw to 6.11 or newer, if you route Google Web Search grounding requests through a local LiteLLM proxy (e.g. `http://192.168.249.131:4000`) and target Vertex AI, you must apply the following overrides in `extensions/google/src/gemini-web-search-provider.runtime.ts`.

---

## The Issues & Solutions

### 1. SSRF Private IP Block (Both Gemini & OpenAI-Compatible paths)

By default, OpenClaw blocks outgoing web search tool requests to private networks (SSRF prevention) using `withTrustedWebSearchEndpoint`.

- **Symptom:** `Blocked hostname or private/internal/special-use IP address`
- **Fix:** Replace `withTrustedWebSearchEndpoint` with `withSelfHostedWebSearchEndpoint` so private proxy IP addresses are permitted.

### 2. LiteLLM Google Search Tool Mapping (`openai-compatible` path)

Standard OpenClaw OpenAI-compatible payload uses `google_search` (snake_case). However, LiteLLM's Vertex AI translator strictly expects `googleSearch` (camelCase) to map the payload to Vertex AI Grounding.

- **Symptom:** Vertex AI/LiteLLM rejects or ignores the grounding tool.
- **Fix:** Update the request payload to use `googleSearch`:
  ```typescript
  body: JSON.stringify({
    model: params.model,
    messages: [{ role: "user", content: params.query }],
    tools: [{ googleSearch: googleSearch }], // Updated from google_search
  }),
  ```

### 3. Missing Explicit Role in Payload (`gemini` path)

Standard Gemini REST payloads usually omit the explicit `role` when sending a single message, defaulting to `user`. However, LiteLLM's Gemini parser strictly validates the roles before translating to Vertex AI. Omitting it throws a role validation error.

- **Symptom:** `litellm.BadRequestError: Vertex_aiException BadRequestError - Please use a valid role: user, model.`
- **Fix:** Add `role: "user"` explicitly to the contents payload:
  ```typescript
  body: JSON.stringify({
    contents: [{ role: "user", parts: [{ text: params.query }] }], // Added role: "user"
    tools: [{ google_search: googleSearch }],
  }),
  ```

---

## Quick Reference Diff for `gemini-web-search-provider.runtime.ts`

```diff
@@ -21,7 +21,6 @@
   resolveSearchTimeoutSeconds,
   type SearchConfigRecord,
   withSelfHostedWebSearchEndpoint,
-  withTrustedWebSearchEndpoint,
   wrapWebContent,
   writeCachedSearchPayload,
 } from "openclaw/plugin-sdk/provider-web-search";
@@ -231,7 +230,8 @@
           body: JSON.stringify({
             model: params.model,
             messages: [{ role: "user", content: params.query }],
-            tools: [{ google_search: googleSearch }],
+            // LiteLLM and Vertex AI expect "googleSearch" instead of "google_search" in OpenAI-compatible payloads
+            tools: [{ googleSearch: googleSearch }],
           }),
         },
       },
@@ -271,7 +271,7 @@

   const endpoint = `${baseUrl}/models/${params.model}:generateContent`;

-  return withTrustedWebSearchEndpoint(
+  return withSelfHostedWebSearchEndpoint(
     {
       url: endpoint,
       timeoutSeconds: params.timeoutSeconds,
@@ -283,7 +283,7 @@
           "x-goog-api-key": params.apiKey,
         },
         body: JSON.stringify({
-          contents: [{ parts: [{ text: params.query }] }],
+          contents: [{ role: "user", parts: [{ text: params.query }] }],
           tools: [{ google_search: googleSearch }],
         }),
       },
```
