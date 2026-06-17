import Foundation
import Security

/// Minimal Keychain wrapper for secrets. `UserDefaults` (the `piperVoice` pattern)
/// is fine for non-sensitive prefs, but an API key shouldn't sit in a plist — so the
/// Ollama Cloud key lives here instead.
enum Keychain {
    private static let service = "com.jarvis.app"

    /// Store (or, with an empty string, clear) a secret for `account`.
    static func set(_ value: String, for account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(base as CFDictionary)   // idempotent overwrite
        guard !value.isEmpty else { return }  // empty = clear only
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    /// Read a secret for `account`, or "" if absent.
    static func get(_ account: String) -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let s = String(data: data, encoding: .utf8) else { return "" }
        return s
    }
}
