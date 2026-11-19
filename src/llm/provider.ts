import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { parse } from 'dotenv';
import { OpenAICompatible } from './openai-compatible.js';
import { Anthropic } from './anthropic.js';

export interface LLMProvider { complete(system: string, input: string): Promise<string> }
const endpoints = {
  anthropic:'https://api.anthropic.com/v1', openai:'https://api.openai.com/v1',
  deepseek:'https://api.deepseek.com/v1', glm:'https://api.z.ai/api/paas/v4', 'openai-compatible':''
};
async function optional(path: string): Promise<string | undefined> {
  try { return await readFile(path,'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}

export async function loadProvider(configPath?: string, environmentOnly = false): Promise<LLMProvider | undefined> {
  const path = resolve(configPath ?? 'd54-report.config.json');
  const raw = environmentOnly ? undefined : await optional(path);
  if (configPath && !raw) throw Error('Model yapılandırması bulunamadı.');
  const env = environmentOnly ? process.env : {...parse(await optional(resolve(dirname(path),'.env')) ?? ''), ...process.env};
  const settings = raw ? JSON.parse(raw) : {};
  const llm = settings.llm ?? settings;
  const pick = (key: string, envKey: string) => env[envKey] ?? llm[key];
  const name = pick('provider','D54_PROVIDER');
  if (!name || name === 'none') return undefined;
  if (typeof name !== 'string' || !Object.hasOwn(endpoints,name)) throw Error('Desteklenmeyen D54_PROVIDER.');
  const base = pick('base_url','D54_BASE_URL') || endpoints[name as keyof typeof endpoints];
  const model = pick('model','D54_MODEL');
  const key = pick('api_key','D54_API_KEY') || env[name.toUpperCase() + '_API_KEY'] || '';
  if (typeof model !== 'string' || !model.trim() || typeof base !== 'string' || !base ||
      typeof key !== 'string' || (!key && name !== 'openai-compatible')) throw Error('Model için model, uç nokta ve gerekiyorsa API anahtarı tanımlayın.');
  const cfg = {base,model,key};
  return name === 'anthropic' ? new Anthropic(cfg) : new OpenAICompatible(cfg);
}
