'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'google/gemini-3.5-flash';

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
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    // Try fenced or embedded JSON below.
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) {
    const fencedBody = fenced[1].trim();
    try {
      return JSON.parse(fencedBody);
    } catch (_) {
      const balanced = balancedJsonObject(fencedBody);
      if (balanced) return JSON.parse(balanced);
    }
  }

  const embedded = balancedJsonObject(text);
  if (embedded) return JSON.parse(embedded);
  throw new Error('model response did not contain a JSON object');
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

async function chatCompletion({ messages, maxTokens = 1200, temperature = 0.2, timeoutMs = 120000 }) {
  const apiKey = openRouterApiKey();
  if (!apiKey) {
    throw new Error(`OPENROUTER_API_KEY not found in environment or ${configPath()}`);
  }

  const model = process.env.RUNWAVE_AGENT_MODEL || process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const baseUrl = process.env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
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
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false,
        response_format: { type: 'json_object' },
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`OpenRouter HTTP ${response.status}: ${body.slice(0, 1200)}`);
    }

    const payload = JSON.parse(body);
    const choice = (payload.choices || [])[0] || {};
    const text = responseText(choice.message || {});
    if (!text.trim()) throw new Error('empty model response');

    return {
      model,
      text,
      json: parseJsonResponse(text),
      usage: payload.usage || null,
      raw: payload,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  chatCompletion,
  dataUrl,
  openRouterApiKey,
  parseJsonResponse,
};
