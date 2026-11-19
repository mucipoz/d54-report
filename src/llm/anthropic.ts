import type { LLMProvider } from './provider.js';
import { post, type Connection } from './transport.js';

export class Anthropic implements LLMProvider {
  readonly model: string;
  constructor(private readonly config: Connection) { this.model = config.model; }
  async complete(system: string, input: string) {
    const {base,key,model} = this.config;
    const result = await post(base, '/messages', {'x-api-key':key,'anthropic-version':'2023-06-01'},
      { model, system, max_tokens: 3072, messages:[{role:'user',content:input}] }) as
      {content?: {type: string; text?: string}[]};
    const content = result.content?.filter(b => b.type === 'text').map(b => b.text).join('\n');
    if (!content?.trim()) throw Error('Model metin döndürmedi.');
    return content;
  }
}
