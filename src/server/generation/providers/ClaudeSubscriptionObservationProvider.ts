// SPDX-License-Identifier: Apache-2.0

// Uses the Claude subscription OAuth token (stored in keychain by Claude Desktop,
// or via CLAUDE_CODE_OAUTH_TOKEN env var for headless/server environments) to
// call the Anthropic Messages API directly, without an API key.

import { logger } from '../../../utils/logger.js';
import { readClaudeOAuthToken } from '../../../shared/oauth-token.js';
import {
  ServerClassifiedProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// beta header required for OAuth (subscription) auth
const ANTHROPIC_BETA_OAUTH = 'claude-code-20250219';
const DEFAULT_MODEL = 'claude-haiku-4-5';

export interface ClaudeSubscriptionObservationProviderOptions {
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface AnthropicMessagesResponse {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { type?: string; message?: string };
}

export class ClaudeSubscriptionObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'claude-subscription' as const;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClaudeSubscriptionObservationProviderOptions = {}) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxOutputTokens = options.maxOutputTokens ?? 4096;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generate(
    context: ServerGenerationContext,
    signal?: AbortSignal,
  ): Promise<ServerGenerationResult> {
    const { prompt, skippedAll } = buildServerGenerationPrompt(context);
    if (skippedAll) {
      return {
        rawText: '<skip_summary reason="all_events_private" />',
        providerLabel: this.providerLabel,
        modelId: this.model,
      };
    }

    const tokenResult = await readClaudeOAuthToken();
    if (tokenResult.kind === 'absent') {
      throw new ServerClassifiedProviderError(
        `Claude subscription auth unavailable: ${tokenResult.reason}. Set CLAUDE_CODE_OAUTH_TOKEN or ensure Claude Desktop is installed.`,
        { kind: 'auth_invalid', cause: new Error(tokenResult.reason) },
      );
    }
    if (tokenResult.kind === 'expired') {
      throw new ServerClassifiedProviderError(
        `Claude subscription OAuth token expired: ${tokenResult.reason}. Re-login via Claude Desktop or update CLAUDE_CODE_OAUTH_TOKEN.`,
        { kind: 'auth_invalid', cause: new Error(tokenResult.reason) },
      );
    }

    const oauthToken = tokenResult.token;

    let response: Response;
    try {
      response = await this.fetchImpl(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${oauthToken}`,
          'anthropic-version': ANTHROPIC_VERSION,
          'anthropic-beta': ANTHROPIC_BETA_OAUTH,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxOutputTokens,
          temperature: 0.3,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal,
      });
    } catch (networkError) {
      const message = networkError instanceof Error ? networkError.message : String(networkError);
      throw new ServerClassifiedProviderError(`Claude subscription network error: ${message}`, {
        kind: 'transient',
        cause: networkError,
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyClaudeSubscriptionError({ status: response.status, bodyText, headers: response.headers, cause: new Error(`Anthropic API error: ${response.status} - ${bodyText}`) });
    }

    let data: AnthropicMessagesResponse;
    try {
      data = (await response.json()) as AnthropicMessagesResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('Anthropic returned invalid JSON (subscription)', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyClaudeSubscriptionError({
        status: response.status,
        bodyText: `${data.error.type ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Anthropic API error: ${data.error.type} - ${data.error.message}`),
      });
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const rawText = blocks
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text!)
      .join('\n')
      .trim();

    if (!rawText) {
      logger.warn('SDK', 'Anthropic subscription returned empty content', {
        provider: 'claude-subscription',
        model: this.model,
      });
    }

    const usage = data.usage ?? {};
    const tokensUsed =
      typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number'
        ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0)
        : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

interface ClassifyInput {
  status?: number;
  bodyText?: string;
  headers?: Headers | { get(name: string): string | null };
  cause: unknown;
}

function classifyClaudeSubscriptionError(input: ClassifyInput): ServerClassifiedProviderError {
  const status = input.status;
  const body = input.bodyText ?? '';
  const lower = body.toLowerCase();

  if (lower.includes('overloaded')) {
    return new ServerClassifiedProviderError(
      `Anthropic overloaded${status !== undefined ? ` (status ${status})` : ''}`,
      { kind: 'transient', cause: input.cause },
    );
  }

  if (status === 401 || status === 403 || lower.includes('invalid') && lower.includes('token')) {
    return new ServerClassifiedProviderError(
      `Claude subscription auth invalid (${status}) — token may be expired; update CLAUDE_CODE_OAUTH_TOKEN`,
      { kind: 'auth_invalid', cause: input.cause },
    );
  }

  if (status === 429) {
    return new ServerClassifiedProviderError('Anthropic subscription rate limit (429)', {
      kind: 'rate_limit',
      cause: input.cause,
    });
  }

  if (lower.includes('quota exceeded') || lower.includes('usage limit')) {
    return new ServerClassifiedProviderError('Anthropic subscription quota exhausted', {
      kind: 'quota_exhausted',
      cause: input.cause,
    });
  }

  if (lower.includes('prompt is too long') || lower.includes('context window') || lower.includes('max_tokens')) {
    return new ServerClassifiedProviderError('Anthropic subscription context overflow', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status === 529) {
    return new ServerClassifiedProviderError('Anthropic overloaded (529)', { kind: 'transient', cause: input.cause });
  }

  if (status !== undefined && status >= 500 && status < 600) {
    return new ServerClassifiedProviderError(`Anthropic upstream error (status ${status})`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  if (status === 400) {
    return new ServerClassifiedProviderError('Anthropic subscription bad request (400)', {
      kind: 'unrecoverable',
      cause: input.cause,
    });
  }

  if (status === undefined) {
    const message = input.cause instanceof Error ? input.cause.message : String(input.cause);
    return new ServerClassifiedProviderError(`Anthropic subscription network error: ${message}`, {
      kind: 'transient',
      cause: input.cause,
    });
  }

  return new ServerClassifiedProviderError(
    `Anthropic subscription API error: ${status}${body ? ` - ${body.substring(0, 200)}` : ''}`,
    { kind: 'unrecoverable', cause: input.cause },
  );
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
