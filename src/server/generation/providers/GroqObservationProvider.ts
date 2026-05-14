// SPDX-License-Identifier: Apache-2.0

import { logger } from '../../../utils/logger.js';
import {
  ServerClassifiedProviderError,
  classifyHttpProviderError,
} from './shared/error-classification.js';
import { buildServerGenerationPrompt } from './shared/prompt-builder.js';
import type {
  ServerGenerationContext,
  ServerGenerationProvider,
  ServerGenerationResult,
} from './shared/types.js';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

export interface GroqObservationProviderOptions {
  apiKey: string;
  model?: string;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
}

interface GroqResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { total_tokens?: number };
  error?: { code?: string | number; message?: string; type?: string };
}

export class GroqObservationProvider implements ServerGenerationProvider {
  readonly providerLabel = 'groq' as const;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly maxOutputTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GroqObservationProviderOptions) {
    if (!options.apiKey) {
      throw new ServerClassifiedProviderError('Groq API key not configured', {
        kind: 'auth_invalid',
        cause: new Error('apiKey is required'),
      });
    }
    this.apiKey = options.apiKey;
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

    let response: Response;
    try {
      response = await this.fetchImpl(GROQ_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: this.maxOutputTokens,
        }),
        signal,
      });
    } catch (networkError) {
      throw classifyHttpProviderError({
        cause: networkError,
        providerLabel: 'Groq',
      });
    }

    if (!response.ok) {
      const bodyText = await safeReadBody(response);
      throw classifyHttpProviderError({
        status: response.status,
        bodyText,
        headers: response.headers,
        cause: new Error(`Groq API error: ${response.status} - ${bodyText}`),
        providerLabel: 'Groq',
      });
    }

    let data: GroqResponse;
    try {
      data = (await response.json()) as GroqResponse;
    } catch (parseError) {
      throw new ServerClassifiedProviderError('Groq returned invalid JSON', {
        kind: 'parse_error',
        cause: parseError,
      });
    }

    if (data.error) {
      throw classifyHttpProviderError({
        status: response.status,
        bodyText: `${data.error.code ?? data.error.type ?? ''} ${data.error.message ?? ''}`,
        headers: response.headers,
        cause: new Error(`Groq API error: ${data.error.code} - ${data.error.message}`),
        providerLabel: 'Groq',
      });
    }

    const rawText = data.choices?.[0]?.message?.content?.trim() ?? '';
    if (!rawText) {
      logger.warn('SDK', 'Groq returned empty content', {
        provider: 'groq',
        model: this.model,
      });
    }

    const tokensUsed = typeof data.usage?.total_tokens === 'number' ? data.usage.total_tokens : undefined;

    return {
      rawText,
      ...(tokensUsed !== undefined ? { tokensUsed } : {}),
      providerLabel: this.providerLabel,
      modelId: this.model,
    };
  }
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
