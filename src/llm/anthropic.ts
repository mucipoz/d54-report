import { tokenCount, type LLMCompleteOptions, type LLMProvider, type LLMUsage } from './provider.js';
import { post, type Connection } from './transport.js';

export class Anthropic implements LLMProvider {
  readonly model: string;
  private readonly _usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  constructor(private readonly config: Connection) { this.model = config.model; }
  get usage(): LLMUsage { return { ...this._usage }; }
  async complete(system: string, input: string, opts?: LLMCompleteOptions) {
    this._usage.calls++;
    const {base,key,model} = this.config;
    const max_tokens = opts?.maxTokens ?? 3072;
    const body: Record<string, unknown> = {
      model,
      system,
      max_tokens,
      messages: [{ role: 'user', content: input }],
    };
    if (opts?.effort) {
      body.output_config = { effort: opts.effort };
    }
    const result = await post(base, '/messages', {'x-api-key':key,'anthropic-version':'2023-06-01'},
      body, opts?.timeoutMs) as {
        content?: {type: string; text?: string}[];
        stop_reason?: string;
        usage?: {
          input_tokens?: unknown;
          output_tokens?: unknown;
          cache_read_input_tokens?: unknown;
          cache_creation_input_tokens?: unknown;
        };
      };
    if (result.usage) {
      this._usage.inputTokens +=
        tokenCount(result.usage.input_tokens) +
        tokenCount(result.usage.cache_read_input_tokens) +
        tokenCount(result.usage.cache_creation_input_tokens);
      this._usage.outputTokens += tokenCount(result.usage.output_tokens);
    }
    if (result.stop_reason === 'refusal') throw Error('Model isteği reddetti.');
    if (result.stop_reason === 'max_tokens') throw Error('Model yanıtı kesildi.');
    const content = result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!content?.trim()) throw Error('Model metin döndürmedi.');
    return content;
  }
}
