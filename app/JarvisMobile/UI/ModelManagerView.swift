import SwiftUI

/// Download / verify / delete the on-device GGUF (standalone-mode brain).
struct ModelManagerView: View {
    @ObservedObject var manager: ModelManager

    var body: some View {
        Section("On-device model") {
            LabeledContent("Model", value: ModelManager.fileName)
            if manager.installed {
                LabeledContent("Status", value: "ready")
                Button("Delete model", role: .destructive) { manager.delete() }
            } else if manager.downloading {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: manager.progress)
                    Text(manager.statusText.isEmpty
                         ? "\(Int(manager.progress * 100))% — you can leave this screen"
                         : manager.statusText)
                        .font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Button("Download (~2.5 GB)") { Task { await manager.download() } }
                if !manager.statusText.isEmpty {
                    Text(manager.statusText).font(.caption).foregroundStyle(.red)
                }
                Text("Scan the pairing QR first — it carries the download source. "
                     + "Downloads resume if interrupted and survive app re-installs.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }
}
