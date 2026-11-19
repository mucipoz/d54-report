import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
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
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
    try {
      const meta = await file.stat();
      if (!meta.isFile() || meta.size > 256 * 1024) throw Error('Model yapılandırması geçerli bir dosya olmalıdır (en çok 256 KiB).');
      return await file.readFile('utf8');
    } finally { await file.close(); }
  }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}

export async function loadProvider(configPath?: string, environmentOnly = false): Promise<LLMProvider | undefined> {
  const path = resolve(configPath ?? 'd54-report.config.json');
  const raw = environmentOnly ? undefined : await optional(path);
  if (configPath && !raw) throw Error('Model yapılandırması bulunamadı.');
  const dotenv = environmentOnly ? {} : parse(await optional(resolve(dirname(path),'.env')) ?? '');
  const env = {...dotenv, ...process.env};
  let settings;
  try { settings = raw ? JSON.parse(raw) : {}; }
  catch { throw Error('Model yapılandırmasında geçersiz JSON.'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Model yapılandırması bir JSON nesnesi olmalıdır.');
  const llm = settings.llm ?? settings;
  const pick = (key: string, envKey: string) => env[envKey] ?? llm[key];
  const name = pick('provider','D54_PROVIDER');
  if (!name || name === 'none') return undefined;
  if (typeof name !== 'string' || !Object.hasOwn(endpoints,name)) throw Error('Desteklenmeyen D54_PROVIDER.');
  const standard = endpoints[name as keyof typeof endpoints];
  const base = pick('base_url','D54_BASE_URL') || standard;
  const model = pick('model','D54_MODEL');
  const specific = name.toUpperCase() + '_API_KEY';
  const genericKey = pick('api_key','D54_API_KEY');
  const key = genericKey || env[specific] || '';
  if (typeof model !== 'string' || !model.trim() || typeof base !== 'string' || !base ||
      typeof key !== 'string' || (!key && name !== 'openai-compatible')) throw Error('Model için model, uç nokta ve gerekiyorsa API anahtarı tanımlayın.');
  // An implicitly discovered project file cannot redirect a higher-trust credential.
  const keyName = genericKey ? 'D54_API_KEY' : specific;
  const credentialEnv = process.env[keyName] ? process.env : dotenv[keyName] ? env : undefined;
  if (!configPath && key && credentialEnv) {
    const operatorBase = credentialEnv.D54_BASE_URL;
    const standardAllowed = (credentialEnv.D54_PROVIDER === name || keyName === specific) && base === standard;
    if (base !== operatorBase && !standardAllowed) {
      throw Error('Model uç noktası anahtarla aynı ortamda tanımlanmalı veya incelenmiş dosya --config ile seçilmelidir.');
    }
  }
  const cfg = {base,model,key};
  return name === 'anthropic' ? new Anthropic(cfg) : new OpenAICompatible(cfg);
}
