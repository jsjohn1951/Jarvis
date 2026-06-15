#!/usr/bin/env bash
# Benchmark one inference mode (off|draft|ngram) on a fixed greedy code-analysis
# prompt. Prints generation tok/s + a hash of the output (to verify draft/ngram
# produce IDENTICAL text to baseline — proving quality is preserved).
set -euo pipefail
MODE="${1:-off}"
PORT=8099
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROMPT="${JARVIS_BENCH_PROMPT:-Analyze this C function. List its purpose and any bugs.\n\nint sum_to(int n){int s=0;for(int i=0;i<=n;i++){s+=i;}return s;}\nchar* dup(const char*x){char*p=malloc(strlen(x));strcpy(p,x);return p;}}"

JARVIS_SPEC="$MODE" PORT="$PORT" "$SCRIPT_DIR/llama-server-optimized.sh" >"/tmp/bench_$MODE.log" 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
printf "[bench:%s] loading" "$MODE"
t=0; until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do printf '.'; sleep 2; t=$((t+2)); [ $t -ge 180 ] && { echo " TIMEOUT"; cat /tmp/bench_$MODE.log; exit 1; }; done
echo " ready"

RESP=$(curl -s "http://127.0.0.1:$PORT/v1/chat/completions" -H 'Content-Type: application/json' -d "{
  \"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],
  \"temperature\":0,\"seed\":42,\"max_tokens\":400,\"cache_prompt\":false,
  \"chat_template_kwargs\":{\"enable_thinking\":false}
}")
echo "$RESP" | python3 -c "
import sys,json,hashlib
d=json.load(sys.stdin)
m=d['choices'][0]['message']
txt=m.get('content') or m.get('reasoning_content') or ''
t=d.get('timings',{})
print(f\"[bench:$MODE] tg={t.get('predicted_per_second',0):.2f} tok/s  pp={t.get('prompt_per_second',0):.1f} tok/s  out_tokens={t.get('predicted_n','?')}  sha={hashlib.sha256(txt.encode()).hexdigest()[:12]}\")
"
kill $SRV 2>/dev/null || true; sleep 2
