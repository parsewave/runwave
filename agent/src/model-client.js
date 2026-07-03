'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemini-3.5-flash';

function modelJsonParseError(message, text, cause = null) {
  const error = new Error(message);
  error.name = 'ModelJsonParseError';
  error.code = 'RUNWAVE_MODEL_JSON_PARSE';
  error.responseText = String(text || '').slice(0, 8000);
  if (cause) error.cause = cause;
  return error;
}

function isModelJsonParseError(error) {
  return Boolean(error && error.code === 'RUNWAVE_MODEL_JSON_PARSE');
}

function parseFlatYamlValue(file, key) {
  if (!file || !fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const pattern = new RegExp(`^\\s*["']?${key}["']?\\s*:\\s*(.*?)\\s*$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (!match) continue;
    let value = match[1].trim();
    if (!value) return null;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}

function configPath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  return process.env.RUNWAVE_AGENT_CONFIG || (home ? path.join(home, '.c.yaml') : '');
}

function openRouterApiKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY || process.env.RUNWAVE_OPENROUTER_API_KEY;
  if (fromEnv) return fromEnv;

  const file = configPath();
  return parseFlatYamlValue(file, 'OPENROUTER_API_KEY') || parseFlatYamlValue(file, 'RUNWAVE_OPENROUTER_API_KEY');
}

function responseText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object') return item.text || item.content || '';
      return '';
    })
    .join('\n');
}

function balancedJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === '\\') {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonResponse(text) {
  let lastParseError = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (error) {
    lastParseError = error;
    // Try fenced or embedded JSON below.
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    const fencedBody = fenced[1].trim();
    try {
      return JSON.parse(fencedBody);
    } catch (error) {
      lastParseError = error;
      const balanced = balancedJsonObject(fencedBody);
      if (balanced) {
        try {
          return JSON.parse(balanced);
        } catch (balancedError) {
          throw modelJsonParseError('model response contained malformed JSON', text, balancedError);
        }
      }
    }
  }

  const embedded = balancedJsonObject(text);
  if (embedded) {
    try {
      return JSON.parse(embedded);
    } catch (error) {
      throw modelJsonParseError('model response contained malformed JSON', text, error);
    }
  }
  throw modelJsonParseError('model response did not contain a JSON object', text, lastParseError);
}

function mimeType(file) {
  const suffix = path.extname(file).toLowerCase();
  if (suffix === '.png') return 'image/png';
  if (suffix === '.jpg' || suffix === '.jpeg') return 'image/jpeg';
  if (suffix === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function dataUrl(file) {
  const encoded = fs.readFileSync(file).toString('base64');
  return `data:${mimeType(file)};base64,${encoded}`;
}

async function chatCompletion({ messages, maxTokens = 1200, temperature = 0.2, timeoutMs = 120000, attempts = null }) {
  const apiKey = openRouterApiKey();
  if (!apiKey) {
    throw new Error(`OPENROUTER_API_KEY not found in environment or ${configPath()}`);
  }

  const model = process.env.RUNWAVE_AGENT_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
  const attemptCount = Math.max(1, Math.round(Number(attempts || process.env.RUNWAVE_AGENT_MODEL_ATTEMPTS || 3)));
  let lastError = null;
  let requestMessages = messages;

  for (let attempt = 1; attempt <= attemptCount; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://parsewave.local/runwave',
        'X-Title': 'RunWave agentic playtester',
      },
      body: JSON.stringify({
        model,
        messages: requestMessages,
        temperature: attempt === 1 ? temperature : 0,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: 'json_object' },
      }),
    }).finally(() => clearTimeout(timeout));

    const body = await response.text();
    try {
      if (!response.ok) {
        throw new Error(`OpenRouter HTTP ${response.status}: ${body.slice(0, 1200)}`);
      }

      const payload = JSON.parse(body);
      const choice = (payload.choices || [])[0] || {};
      const text = responseText(choice.message || {});
      if (!text.trim()) throw new Error('empty model response');

      const json = parseJsonResponse(text);
      return {
        model,
        text,
        json,
        usage: payload.usage || null,
        raw: payload,
      };
    } catch (error) {
      lastError = error;
      const retryable = attempt < attemptCount;
      if (!retryable) {
        if (body && !String(error.message).startsWith('OpenRouter HTTP')) {
          error.message = `${error.message}; response excerpt=${body.slice(0, 1200)}`;
        }
        throw error;
      }
      if (isModelJsonParseError(error)) {
        requestMessages = [
          ...messages,
          {
            role: 'user',
            content:
              'The previous answer was invalid JSON. Return exactly one valid JSON object matching the requested schema. Do not include markdown, prose, comments, or trailing text.',
          },
        ];
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(1500 * attempt, 5000)));
    }
  }

  throw lastError || new Error('OpenRouter request failed');
}

module.exports = {
  chatCompletion,
  dataUrl,
  isModelJsonParseError,
  openRouterApiKey,
  parseJsonResponse,
};
