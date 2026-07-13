import Foundation
import llama

/// Minimal actor over llama.cpp's C API for the on-device tier: load a GGUF with
/// Metal offload, apply the model's embedded chat template, stream a completion.
///
/// Deliberately touches only the stable C core (model load, tokenize, decode,
/// sampler chain, chat template) so bumping the pinned llama.cpp tag in
/// scripts/build-llama-xcframework.sh stays low-risk. One engine instance owns
/// one context; Jarvis only ever runs one local generation at a time.
actor LlamaEngine {
    struct ChatMessage {
        var role: String   // "system" | "user" | "assistant"
        var content: String
    }

    enum EngineError: Error, LocalizedError {
        case modelLoadFailed(String)
        case contextFailed
        case templateFailed
        case decodeFailed
        var errorDescription: String? {
            switch self {
            case .modelLoadFailed(let p): return "couldn't load model at \(p)"
            case .contextFailed: return "couldn't create llama context"
            case .templateFailed: return "couldn't apply the chat template"
            case .decodeFailed: return "llama_decode failed"
            }
        }
    }

    // nonisolated(unsafe): OpaquePointer isn't Sendable, but deinit is the only
    // nonisolated access and by then no other reference can exist.
    nonisolated(unsafe) private let model: OpaquePointer
    private let vocab: OpaquePointer
    private let nCtx: Int32
    nonisolated(unsafe) private var ctx: OpaquePointer?

    init(modelPath: URL, nCtx: Int32 = 4096) throws {
        llama_backend_init()
        var mparams = llama_model_default_params()
        mparams.n_gpu_layers = 99   // full Metal offload on iPhone
        guard let m = llama_model_load_from_file(modelPath.path, mparams) else {
            throw EngineError.modelLoadFailed(modelPath.lastPathComponent)
        }
        model = m
        vocab = llama_model_get_vocab(m)
        self.nCtx = nCtx
    }

    deinit {
        if let ctx { llama_free(ctx) }
        llama_model_free(model)
    }

    /// Render `messages` through the GGUF's embedded chat template (Gemma's, for
    /// the default model) with the assistant turn opened.
    private func renderPrompt(_ messages: [ChatMessage]) throws -> String {
        let tmpl = llama_model_chat_template(model, nil)
        // C-string lifetimes: keep the std strings alive across the C call.
        let roles = messages.map { strdup($0.role)! }
        let contents = messages.map { strdup($0.content)! }
        defer { roles.forEach { free($0) }; contents.forEach { free($0) } }
        var msgs: [llama_chat_message] = (0..<messages.count).map {
            llama_chat_message(role: roles[$0], content: contents[$0])
        }
        let cap = messages.reduce(1024) { $0 + $1.content.utf8.count + 64 }
        var buf = [CChar](repeating: 0, count: cap)
        let n = llama_chat_apply_template(tmpl, &msgs, msgs.count, true, &buf, Int32(cap))
        guard n > 0, n <= Int32(cap) else { throw EngineError.templateFailed }
        return String(decoding: buf[0..<Int(n)].map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    private func tokenize(_ text: String) -> [llama_token] {
        let utf8 = Array(text.utf8)
        var tokens = [llama_token](repeating: 0, count: utf8.count + 16)
        let n = llama_tokenize(vocab, text, Int32(utf8.count), &tokens, Int32(tokens.count), true, true)
        guard n >= 0 else { return [] }
        return Array(tokens[0..<Int(n)])
    }

    private func piece(_ token: llama_token) -> String {
        var buf = [CChar](repeating: 0, count: 128)
        let n = llama_token_to_piece(vocab, token, &buf, Int32(buf.count), 0, true)
        guard n > 0 else { return "" }
        return String(decoding: buf[0..<Int(n)].map { UInt8(bitPattern: $0) }, as: UTF8.self)
    }

    /// Generate a reply, streaming pieces through `onToken`. `grammarGBNF`
    /// constrains output (used by the research skill's query generator).
    func generate(
        messages: [ChatMessage],
        temperature: Float = 0.6,
        grammarGBNF: String? = nil,
        maxTokens: Int32 = 512,
        onToken: (@Sendable (String) -> Void)? = nil
    ) throws -> String {
        // Fresh context per turn: simple and predictable memory behavior on a
        // phone (a 4k-ctx KV for a 4B Q4 is rebuilt in well under a second).
        if let old = ctx { llama_free(old); ctx = nil }
        var cparams = llama_context_default_params()
        cparams.n_ctx = UInt32(nCtx)
        cparams.n_batch = UInt32(nCtx)
        guard let c = llama_init_from_model(model, cparams) else { throw EngineError.contextFailed }
        ctx = c

        let prompt = try renderPrompt(messages)
        var tokens = tokenize(prompt)
        if tokens.count >= Int(nCtx) - Int(maxTokens) {
            // Clamp long histories from the front (system prompt survives poorly,
            // but callers cap history well before this — last-resort guard).
            tokens = Array(tokens.suffix(Int(nCtx) - Int(maxTokens) - 8))
        }

        let chain = llama_sampler_chain_init(llama_sampler_chain_default_params())
        defer { llama_sampler_free(chain) }
        if let gbnf = grammarGBNF {
            llama_sampler_chain_add(chain, llama_sampler_init_grammar(vocab, gbnf, "root"))
        }
        llama_sampler_chain_add(chain, llama_sampler_init_top_k(40))
        llama_sampler_chain_add(chain, llama_sampler_init_top_p(0.95, 1))
        llama_sampler_chain_add(chain, llama_sampler_init_temp(temperature))
        llama_sampler_chain_add(chain, llama_sampler_init_dist(UInt32.random(in: .min ... .max)))

        var batch = llama_batch_get_one(&tokens, Int32(tokens.count))
        var out = ""
        for _ in 0..<maxTokens {
            guard llama_decode(c, batch) == 0 else { throw EngineError.decodeFailed }
            var tok = llama_sampler_sample(chain, c, -1)
            if llama_vocab_is_eog(vocab, tok) { break }
            let s = piece(tok)
            out += s
            if let onToken, !s.isEmpty { onToken(s) }
            batch = llama_batch_get_one(&tok, 1)
        }
        return out
    }

    /// Drop the decode context (keep weights) — called when the app backgrounds.
    func releaseContext() {
        if let old = ctx { llama_free(old); ctx = nil }
    }
}
