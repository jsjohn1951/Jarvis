# Troubleshooting

## Ports
| Port | Service | Check |
|------|---------|-------|
| 8080 | llama.cpp | `curl -sf http://127.0.0.1:8080/health` |
| 9090 | router | `lsof -i :9090` |
| 7777 | orchestrator | `lsof -i :7777` |

## llama.cpp won't start / no GPU
- Confirm the Metal build: `ls ~/llama.cpp/build/bin/libggml-metal.dylib` (should exist).
- Watch GPU usage in Activity Monitor while generating; `-ngl 99` should offload all layers.
- ⚠️ Do **not** replace this with `brew install llama.cpp` — brew bottles may omit Metal, losing GPU + unified-memory acceleration.

## Speculative decoding gives no speedup
- Acceptance rate is low for the workload, or the draft model's tokenizer differs from the 9B's. Re-check draft selection in [MODELS.md](MODELS.md). Try smaller `--draft-max`.

## Out of memory / swap thrashing (18 GB)
- Lower `-c` (context). 70k KV cache is large; 32k is plenty for most code tasks.
- Don't co-load two big models — let the orchestrator hot-swap instead.

## Orchestrator can't reach Anthropic (hybrid agents fail)
- Auth is via your **Claude Pro subscription**, not an API key. Make sure you're logged in: run `claude` once and complete `/login` if prompted.
- ⚠️ Make sure `ANTHROPIC_API_KEY` is **not** set in your environment — a stray key overrides the subscription. Check with `echo $ANTHROPIC_API_KEY` (should be empty); `unset ANTHROPIC_API_KEY` if present.
- The orchestrator points agents at the router via `ANTHROPIC_BASE_URL=http://127.0.0.1:9090`; the router passes your subscription's OAuth headers straight through.
- The `quick` agent and all llama.cpp work are 100% local — they never need auth.

## App can't hear me
- System Settings → Privacy & Security → Microphone / Speech Recognition → enable Jarvis.
- Wake word off? Toggle it in voice config.

## App can't connect
- Orchestrator not running, or firewall. Confirm `ws://127.0.0.1:7777` with `lsof -i :7777`.
</content>
