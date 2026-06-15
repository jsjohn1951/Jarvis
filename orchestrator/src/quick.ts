import { config } from "./config.js";

/**
 * Stream a completion from the local 2B 'quick' tier (OpenAI-compatible, :8081).
 * Yields text deltas. Thinking is disabled (Qwen3 puts the answer in
 * reasoning_content otherwise — same quirk the router handles).
 */
export async function* quickStream(
  prompt: string,
  system?: string,
  maxTokens = 512,
): AsyncGenerator<string> {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch(`${config.quickUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: config.quickModel,
      messages,
      stream: true,
      temperature: 0.3,
      max_tokens: maxTokens,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!res.ok || !res.body) throw new Error(`quick tier ${res.status}`);

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
        const delta = json.choices?.[0]?.delta;
        const text = delta?.content ?? delta?.reasoning_content;
        if (text) yield text;
      } catch {
        /* partial SSE frame; ignore */
      }
    }
  }
}

/** Non-streaming convenience used by the dispatcher. */
export async function quickComplete(prompt: string, system?: string, maxTokens = 256): Promise<string> {
  let out = "";
  for await (const t of quickStream(prompt, system, maxTokens)) out += t;
  return out.trim();
}
