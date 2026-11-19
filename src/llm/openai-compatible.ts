import type { LLMProvider } from './provider.js';
import { post, type Connection } from './transport.js';

export class OpenAICompatible implements LLMProvider {
  constructor(private readonly config: Connection) {}
  async complete(system: string, input: string) {
    const {base,key,model} = this.config;
    const result = await post(base, '/chat/completions', key ? {Authorization: 'Bearer ' + key} : {},
      { model, messages: [{role:'system',content:system},{role:'user',content:input}] }) as
      {choices?: {message?: {content?: unknown}}[]};
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw Error('Model metin döndürmedi.');
    return content;
  }
}
