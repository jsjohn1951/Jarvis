import { config } from "./config.js";

/**
 * Stream a completion from the local 'conversation' tier — Gemma 3 4B, served
 * OpenAI-compatible on :8083 (see scripts/llama-convo.sh). This is the USER-FACING
 * dialog model (greetings, smalltalk, the instant ack, local factual answers); the
 * cheaper 2B 'quick' tier (quick.ts) stays reserved for internal classifiers.
 *
 * Unlike Qwen3 (quick.ts), Gemma has no reasoning_content split and no
 * enable_thinking toggle — its answer is always in delta.content — so this client is
 * a touch simpler and runs a slightly warmer temperature for more natural dialog.
 */
export async function* convoStream(
  prompt: string,
  system?: string,
  history: { role: "user" | "assistant"; content: string }[] = [],
  maxTokens = 512,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    ...history,
    { role: "user", content: prompt },
  ];
  const res = await fetch(`${config.convoUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,   // barge-in: aborting stops Gemma generating, not just the read loop
    body: JSON.stringify({
      model: config.convoModel,
      messages,
      stream: true,
      temperature: 0.6,
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`convo tier ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") return;
      try {
        const json = JSON.parse(data);
        const text = json.choices?.[0]?.delta?.content;
        if (text) yield text;
      } catch {
        /* partial SSE frame; ignore */
      }
    }
  }
}

/** Non-streaming convenience (mirrors quickComplete). */
export async function convoComplete(prompt: string, system?: string, maxTokens = 256): Promise<string> {
  let out = "";
  for await (const t of convoStream(prompt, system, [], maxTokens)) out += t;
  return out.trim();
}
