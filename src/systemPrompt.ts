import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { createHash } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { preprocess } from './deterministic.js'

const CACHE_FILE = join(homedir(), '.squeezr', 'sysprompt_cache.json')
const MIN_LENGTH = 2000

const PROMPT =
  'Compress this AI assistant system prompt to under 600 tokens. ' +
  'Keep: tool names, behavioral rules, key constraints, critical instructions. ' +
  'Remove: verbose examples, repetitive explanations, formatting guides, long documentation. ' +
  'Output only the compressed prompt.'

function cacheKey(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

function loadCache(): Record<string, string> {
  try {
    if (existsSync(CACHE_FILE)) return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  } catch { /* ignore */ }
  return {}
}

function saveCache(cache: Record<string, string>): void {
  try {
    const dir = join(homedir(), '.squeezr')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(cache))
  } catch { /* ignore */ }
}

export async function compressSystemPrompt(
  prompt: string,
  apiKey: string,
  backend: 'haiku' | 'gpt-mini' | 'gemini-flash' | 'ollama',
): Promise<{ text: string; originalLen: number; compressedLen: number }> {
  if (!prompt || prompt.length < MIN_LENGTH) return { text: prompt, originalLen: prompt.length, compressedLen: prompt.length }

  // Deterministic pre-pass — strip ANSI, timestamps, dedup lines, collapse
  // whitespace. Free, no API call. Often saves 5-15% before Haiku/GPT touches it.
  // The cache is keyed off the *deterministic* output so semantically-equivalent
  // prompts (same content, different whitespace) hit the same cache entry.
  const detPrompt = preprocess(prompt)
  const originalLen = prompt.length

  const cache = loadCache()
  const key = cacheKey(detPrompt)
  if (cache[key]) return { text: cache[key], originalLen, compressedLen: cache[key].length }

  // If deterministic alone saved >25%, that's a respectable win — skip the AI
  // call entirely. Saves a Haiku request and the latency it adds.
  if (detPrompt.length < originalLen * 0.75) {
    cache[key] = detPrompt
    saveCache(cache)
    const ratio = Math.round((1 - detPrompt.length / originalLen) * 100)
    console.log(`[squeezr/sysprompt-det] Deterministic-only: -${ratio}% (${originalLen.toLocaleString()} → ${detPrompt.length.toLocaleString()} chars) [cached, no AI]`)
    return { text: detPrompt, originalLen, compressedLen: detPrompt.length }
  }

  try {
    let compressed: string
    // Feed the deterministic-cleaned prompt to the AI (fewer noise tokens).
    const input = `${PROMPT}\n\n---\n${detPrompt.slice(0, 10000)}`

    if (backend === 'haiku') {
      const authOpts = apiKey.startsWith('sk-') ? { apiKey } : { authToken: apiKey }
      const client = new Anthropic(authOpts)
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 700,
        messages: [{ role: 'user', content: input }],
      })
      compressed = (resp.content[0] as { text: string }).text
    } else if (backend === 'gpt-mini') {
      const client = new OpenAI({ apiKey })
      const resp = await client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 700,
        messages: [{ role: 'user', content: input }],
      })
      compressed = resp.choices[0].message.content ?? prompt
    } else if (backend === 'gemini-flash') {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-8b:generateContent?key=${apiKey}`
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: input }] }] }),
      })
      const data = (await resp.json()) as { candidates: Array<{ content: { parts: Array<{ text: string }> } }> }
      compressed = data.candidates[0].content.parts[0].text
    } else {
      // Ollama: fall back to the deterministic-only output rather than the raw
      // original. We never want to return a prompt we never touched.
      return { text: detPrompt, originalLen, compressedLen: detPrompt.length }
    }

    const ratio = Math.round((1 - compressed.length / originalLen) * 100)
    console.log(`[squeezr/${backend}] System prompt compressed: -${ratio}% (${originalLen.toLocaleString()} → ${compressed.length.toLocaleString()} chars) [cached]`)
    cache[key] = compressed
    saveCache(cache)
    return { text: compressed, originalLen, compressedLen: compressed.length }
  } catch {
    // AI compression failed — still return the deterministic-cleaned text
    // instead of the raw original. The pre-pass was free.
    return { text: detPrompt, originalLen, compressedLen: detPrompt.length }
  }
}
