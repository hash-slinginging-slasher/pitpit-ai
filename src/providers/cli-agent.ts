import type { AgentConfig, ProviderId } from '../config.js';
import { runOpenAICompatibleAgent, type AgentRunOptions, type AgentRunResult } from '../local-agent.js';
import type { ChatMessage } from '../agent.js';
import { runClaudeOAuthAgent } from './anthropic-agent.js';
import { runGeminiAgent } from './gemini-agent.js';
import { readCodexAuth } from './credentials.js';

/**
 * Dispatcher for the subscription-CLI routers. Each reads the corresponding CLI's
 * credentials from its local store and drives our tool loop against that backend.
 *
 *   cli/claude  — Anthropic Messages via Claude Code OAuth (fully supported).
 *   cli/codex   — OpenAI API when the codex login used an API key (supported);
 *                 the ChatGPT-subscription backend is not validated here.
 *   cli/gemini  — Gemini generateContent via a Gemini API key, or the CLI's Code
 *                 Assist OAuth login (network path not validated on this machine).
 *   cli/jules   — no stable public completion API yet (experimental).
 */
export async function runCliAgent(
  provider: ProviderId,
  config: AgentConfig,
  model: string,
  input: string | ChatMessage[],
  options?: AgentRunOptions,
): Promise<AgentRunResult> {
  switch (provider) {
    case 'cli-claude':
      return runClaudeOAuthAgent(config, model, input, options);

    case 'cli-codex': {
      const auth = readCodexAuth();
      if (auth.apiKey) {
        // API-key login → standard OpenAI API (OpenAI-compatible). Override the
        // model with cli/codex/<model-id>; defaults to gpt-4o.
        const wireModel = model.replace(/^cli\/codex\/?/, '') || 'gpt-4o';
        return runOpenAICompatibleAgent(
          { baseUrl: 'https://api.openai.com/v1', apiKey: auth.apiKey, wireModel },
          config,
          input,
          options,
        );
      }
      throw new Error(
        auth.subscriptionOnly
          ? 'cli/codex is signed in with a ChatGPT subscription, whose backend is not supported yet. ' +
            'Run `codex login --api-key <key>` (or set OPENAI_API_KEY) to use cli/codex.'
          : 'Codex is not logged in — run `codex` and sign in first.',
      );
    }

    case 'cli-gemini':
      // Uses a Gemini API key (GEMINI_API_KEY) if set, else the Gemini CLI's OAuth login.
      return runGeminiAgent(config, model, input, options);

    case 'cli-jules':
      throw new Error('cli/jules is experimental: Jules has no stable public completion API wired up yet.');

    default: {
      const name = provider.replace(/^cli-/, '');
      throw new Error(`Unknown CLI router: ${name}.`);
    }
  }
}
