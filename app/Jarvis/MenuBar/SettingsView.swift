import SwiftUI

/// Holds the alternate-provider settings (currently Ollama Cloud, the fallback used
/// when Claude is rate-limited, before the local model). Non-secret prefs live in
/// `UserDefaults` (the app's existing pattern); the API key lives in the Keychain.
@MainActor
final class ProviderSettings: ObservableObject {
    @Published var ollamaEnabled: Bool
    @Published var ollamaModel: String
    @Published var ollamaKey: String

    static let defaultModel = "gpt-oss:120b"
    private enum K {
        static let enabled = "ollamaEnabled"
        static let model = "ollamaModel"
        static let key = "ollamaApiKey"
    }

    init() {
        ollamaEnabled = UserDefaults.standard.bool(forKey: K.enabled)
        ollamaModel = UserDefaults.standard.string(forKey: K.model) ?? Self.defaultModel
        ollamaKey = Keychain.get(K.key)
    }

    /// Persist locally (UserDefaults + Keychain) and push to the orchestrator.
    func save(pushingTo client: OrchestratorClient) {
        UserDefaults.standard.set(ollamaEnabled, forKey: K.enabled)
        UserDefaults.standard.set(ollamaModel, forKey: K.model)
        Keychain.set(ollamaKey, for: K.key)
        push(to: client)
    }

    /// Send the current settings to the orchestrator (also called once at launch).
    func push(to client: OrchestratorClient) {
        client.sendProviderConfig(enabled: ollamaEnabled, model: ollamaModel, apiKey: ollamaKey)
    }
}

/// Settings window — provider fallback configuration.
struct SettingsView: View {
    @ObservedObject var client: OrchestratorClient
    @ObservedObject var providers: ProviderSettings
    @State private var saved = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("FALLBACK PROVIDER")
                .font(Theme.label()).tracking(2).foregroundStyle(Theme.onSurfaceVariant)

            GlassPanel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Ollama Cloud").font(Theme.display(14)).foregroundStyle(Theme.onSurface)
                    Text("Used when Claude is rate-limited — tried before the local model.")
                        .font(Theme.mono).foregroundStyle(Theme.onSurfaceVariant)

                    Toggle("Enabled", isOn: $providers.ollamaEnabled)
                        .toggleStyle(.switch).tint(Theme.primary).font(Theme.body)
                        .foregroundStyle(Theme.onSurface)

                    field("Model", text: $providers.ollamaModel, secure: false, placeholder: ProviderSettings.defaultModel)
                    field("API Key", text: $providers.ollamaKey, secure: true, placeholder: "Ollama Cloud key")

                    HStack(spacing: 10) {
                        Button { providers.save(pushingTo: client); saved = true } label: {
                            Text("SAVE").font(Theme.label()).tracking(1.2)
                                .foregroundStyle(Theme.onPrimary)
                                .padding(.horizontal, 14).padding(.vertical, 7)
                                .background(Theme.primary)
                                .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
                        }
                        .buttonStyle(.plain)
                        if saved {
                            Text(client.connected ? "saved" : "saved (offline — will apply on reconnect)")
                                .font(Theme.mono).foregroundStyle(Theme.primary)
                        }
                        Spacer()
                    }
                }
            }
            Spacer()
        }
        .padding(20)
        .frame(width: 440, height: 340)
        .background(Theme.base)
    }

    @ViewBuilder
    private func field(_ label: String, text: Binding<String>, secure: Bool, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased()).font(Theme.label()).tracking(1).foregroundStyle(Theme.onSurfaceVariant)
            Group {
                if secure { SecureField(placeholder, text: text) }
                else { TextField(placeholder, text: text) }
            }
            .textFieldStyle(.plain).font(Theme.body).foregroundStyle(Theme.onSurface)
            .padding(.horizontal, 10).padding(.vertical, 7)
            .background(Theme.surface)
            .overlay(RoundedRectangle(cornerRadius: Theme.radius)
                .strokeBorder(Theme.outline.opacity(0.4), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius))
        }
        .onChange(of: text.wrappedValue) { saved = false }
    }
}
