import { Router, type IRouter } from "express";
import {
  CreateAiSuggestionBody,
  CreateAiSuggestionResponse,
  ListAiModelsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const AIASSIST_BASE_URL = "https://api.AiAssist.net";
const AIASSIST_PROVIDER = "pin";
const DEFAULT_MODEL = "GLM-4-32B";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * The credential is `AIASSIST_API_KEY`. `AIAssIST_API_KEY` was the original,
 * awkwardly-cased spelling and is still accepted so an existing install keeps
 * working, but it warns once: two names for one credential is exactly how an
 * environment ends up with a stale copy that nobody notices is unused.
 */
const LEGACY_API_KEY_VAR = "AIAssIST_API_KEY";
let warnedAboutLegacyKeyVar = false;

function getApiKey() {
  const key = process.env.AIASSIST_API_KEY?.trim();
  if (key) return key;

  const legacy = process.env[LEGACY_API_KEY_VAR]?.trim();
  if (legacy) {
    if (!warnedAboutLegacyKeyVar) {
      warnedAboutLegacyKeyVar = true;
      console.warn(
        `[ai] Using ${LEGACY_API_KEY_VAR}, which is deprecated. Save the same value as AIASSIST_API_KEY and delete the old one.`,
      );
    }
    return legacy;
  }

  throw new Error("AIASSIST_API_KEY is not configured");
}

function parseJsonContent(content: string) {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed: unknown = JSON.parse(normalized);
  if (!Array.isArray(parsed)) {
    throw new Error("AiAssist returned a non-array suggestion payload");
  }
  return parsed;
}

router.get("/ai/models", async (req, res) => {
  try {
    const response = await fetch(`${AIASSIST_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
      },
    });
    if (!response.ok) {
      req.log.error({ status: response.status }, "AiAssist models request failed");
      return res.status(502).json({ error: "Unable to load AI models" });
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; name?: string }>;
      models?: Array<{ id?: string; name?: string }>;
    };
    const models = (payload.data ?? payload.models ?? [])
      .filter((model) => model.id)
      .map((model) => ({ id: model.id!, name: model.name ?? model.id! }));

    return res.json(ListAiModelsResponse.parse({ models }));
  } catch (error) {
    req.log.error({ err: error }, "AiAssist models request failed");
    return res.status(502).json({ error: "Unable to load AI models" });
  }
});

router.post("/ai/suggest", async (req, res) => {
  const parsed = CreateAiSuggestionBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid AI suggestion request" });
  }

  const input = parsed.data;
  const model = input.model || DEFAULT_MODEL;
  const count = input.numberOfSuggestions ?? 3;
  const maxCharacters = input.maxCharacters ?? 1300;
  const systemPrompt = [
    "You are a senior social media editor.",
    "Return ONLY a valid JSON array, with no markdown fences.",
    'Each item must have exactly: "text", "rationale", and "characterCount".',
    `Create ${count} distinct suggestions for ${input.platform}.`,
    `Keep each text under ${maxCharacters} characters.`,
    input.includeHashtags === false
      ? "Do not add hashtags."
      : "Use hashtags only when they add real discovery value.",
  ].join(" ");

  try {
    const response = await fetch(`${AIASSIST_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
        "X-AiAssist-Provider": AIASSIST_PROVIDER,
      },
      body: JSON.stringify({
        model,
        temperature: 0.75,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              task: input.task,
              tone: input.tone,
              audience: input.audience,
              sourceText: input.sourceText,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      req.log.error(
        { status: response.status, response: errorText.slice(0, 300) },
        "AiAssist suggestion request failed",
      );
      return res.status(502).json({ error: "AiAssist could not generate suggestions" });
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AiAssist returned no message content");
    }

    const suggestions = parseJsonContent(content);
    const result = CreateAiSuggestionResponse.parse({
      suggestions: suggestions.slice(0, count).map((suggestion) => ({
        text: String(suggestion.text ?? ""),
        rationale: String(suggestion.rationale ?? ""),
        characterCount: String(suggestion.text ?? "").length,
      })),
      model: payload.model ?? model,
      provider: AIASSIST_PROVIDER,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    });

    return res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "AI suggestion parsing or request failed");
    return res.status(502).json({ error: "AI suggestions are temporarily unavailable" });
  }
});

export default router;