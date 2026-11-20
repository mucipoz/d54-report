import { tokenCount, type LLMCompleteOptions, type LLMProvider, type LLMUsage } from './provider.js';
import { post, type Connection } from './transport.js';

export class OpenAICompatible implements LLMProvider {
  readonly model: string;
  private readonly _usage: LLMUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };
  constructor(private readonly config: Connection) { this.model = config.model; }
  get usage(): LLMUsage { return { ...this._usage }; }
  async complete(system: string, input: string, opts?: LLMCompleteOptions) {
    this._usage.calls++;
    const {base,key,model} = this.config;
    let isOfficialOpenAI = false;
    try {
      isOfficialOpenAI = new URL(base).hostname.toLowerCase() === 'api.openai.com';
    } catch {
      // Geçersiz adres transport.post tarafından reddedilir.
    }
    const maxTokenField = opts?.maxTokens !== undefined
      ? (isOfficialOpenAI ? { max_completion_tokens: opts.maxTokens } : { max_tokens: opts.maxTokens })
      : {};
    const payload = {
      model,
      messages: [{role:'system',content:system},{role:'user',content:input}],
      ...maxTokenField,
    };
    const result = await post(base, '/chat/completions', key ? {Authorization: 'Bearer ' + key} : {}, payload, opts?.timeoutMs) as {
      choices?: {message?: {content?: unknown}}[];
      usage?: {prompt_tokens?: unknown; completion_tokens?: unknown};
    };
    if (result.usage) {
      this._usage.inputTokens += tokenCount(result.usage.prompt_tokens);
      this._usage.outputTokens += tokenCount(result.usage.completion_tokens);
    }
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Error('Model metin döndürmedi.');
    return content;
  }
}
