import type { AgentConfig, ProviderId } from '../config.js';
import { runOpenAICompatibleAgent, type AgentRunOptions, type AgentRunResult } from '../local-agent.js';
import type { ChatMessage } from '../agent.js';
import { runClaudeOAuthAgent } from './anthropic-agent.js';
import { runGeminiAgent } from './gemini-agent.js';
import { runJulesAgent } from './jules-agent.js';
import { runCodexOAuthAgent } from './codex-agent.js';
import { runOpenCodeAgent } from './opencode-agent.js';
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
 *   cli/jules   — Jules async agent (jules.googleapis.com): submits a task against a
 *                 connected GitHub repo and opens a PR. Needs a Jules API key.
 *   cli/opencode — OpenCode local agent: delegates to `opencode run`, editing files
 *                 in the current directory using OpenCode's own provider auth.
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
      if (auth.subscriptionOnly) {
        // ChatGPT-subscription login → experimental Responses-API proxy to the
        // ChatGPT backend (reverse-engineered; may need iteration).
        return runCodexOAuthAgent(config, model, input, options);
      }
      throw new Error('Codex is not logged in — run `codex login` and sign in first.');
    }

    case 'cli-gemini':
      // Uses a Gemini API key (GEMINI_API_KEY) if set, else the Gemini CLI's OAuth login.
      return runGeminiAgent(config, model, input, options);

    case 'cli-jules':
      // Jules is an async agent that works on a connected GitHub repo and opens a PR
      // (it does NOT edit the local cwd or use our tools). Needs a Jules API key.
      return runJulesAgent(config, model, input, options);

    case 'cli-opencode':
      // OpenCode is a local open-source agent — delegate the turn to `opencode run`
      // (it edits files in the current directory using its own provider auth).
      return runOpenCodeAgent(config, model, input, options);

    default: {
      const name = provider.replace(/^cli-/, '');
      throw new Error(`Unknown CLI router: ${name}.`);
    }
  }
}
