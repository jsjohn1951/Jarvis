import Foundation
import CryptoKit

/// Downloads and verifies the on-device GGUF.
///
/// The file lives in Application Support (persists across app updates AND the
/// 7-day free-signing reinstalls, as long as the bundle id + team are stable)
/// and is excluded from iCloud backup (re-downloadable, 2.5 GB). The transfer
/// uses URLSessionDownloadTask — NOT an async-bytes loop: iterating 2.5 GB
/// byte-by-byte on the main actor froze the app long enough for the iOS
/// watchdog to kill it. The download task streams to disk off-main and reports
/// progress via delegate callbacks; on failure we keep resume data (works
/// against servers with Range support, e.g. HuggingFace).
@MainActor
final class ModelManager: ObservableObject {
    enum ModelError: Error, LocalizedError {
        case notDownloaded
        case noSource
        case badChecksum
        case httpError(Int)
        var errorDescription: String? {
            switch self {
            case .notDownloaded: return "the local model isn't downloaded yet"
            case .noSource: return "no model URL configured — scan the pairing QR first"
            case .badChecksum: return "downloaded model failed checksum verification"
            case .httpError(let c): return "model download failed (HTTP \(c))"
            }
        }
    }

    @Published var progress: Double = 0        // 0…1
    @Published var downloading = false
    @Published var statusText = ""
    @Published private(set) var installed = ModelManager.installedModelURL() != nil

    static let fileName = "gemma-3-4b-it-Q4_K_M.gguf"

    private var resumeData: Data?

    static func modelsDir() -> URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appending(path: "Models")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    /// The verified, ready-to-load model file, or nil.
    static func installedModelURL() -> URL? {
        let url = modelsDir().appending(path: fileName)
        return FileManager.default.fileExists(atPath: url.path) ? url : nil
    }

    func download() async {
        guard !downloading else { return }
        guard let source = UserDefaults.standard.string(forKey: "jarvis.modelURL"),
              let url = URL(string: source) else {
            statusText = ModelError.noSource.localizedDescription
            return
        }
        downloading = true
        statusText = "downloading…"
        defer { downloading = false }
        do {
            let tmp = try await fetchToTemp(url)
            statusText = "verifying…"
            try await verify(tmp)
            try install(tmp)
            resumeData = nil
            installed = true
            statusText = "ready"
        } catch {
            statusText = error.localizedDescription
        }
    }

    func delete() {
        try? FileManager.default.removeItem(at: Self.modelsDir().appending(path: Self.fileName))
        resumeData = nil
        installed = false
        progress = 0
        statusText = ""
    }

    // MARK: - Transfer (URLSessionDownloadTask, off-main)

    private func fetchToTemp(_ url: URL) async throws -> URL {
        let bridge = DownloadBridge(
            onProgress: { [weak self] p in Task { @MainActor in self?.progress = p } },
            onResumeData: { [weak self] d in Task { @MainActor in self?.resumeData = d } }
        )
        let session = URLSession(configuration: .default, delegate: bridge, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let resume = resumeData
        return try await withCheckedThrowingContinuation { cont in
            bridge.continuation = cont
            let task = resume.map { session.downloadTask(withResumeData: $0) } ?? session.downloadTask(with: url)
            task.resume()
        }
    }

    /// Verify sha256 (when the pairing payload supplied one) off the main actor —
    /// hashing 2.5 GB synchronously would hitch the UI for seconds.
    private func verify(_ file: URL) async throws {
        let expected = (UserDefaults.standard.string(forKey: "jarvis.modelSHA256") ?? "").lowercased()
        guard !expected.isEmpty else { return }
        let digest = try await Task.detached(priority: .utility) {
            var hasher = SHA256()
            let handle = try FileHandle(forReadingFrom: file)
            defer { try? handle.close() }
            while let chunk = try handle.read(upToCount: 8 << 20), !chunk.isEmpty {
                hasher.update(data: chunk)
            }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }.value
        guard digest == expected else {
            try? FileManager.default.removeItem(at: file)
            throw ModelError.badChecksum
        }
    }

    private func install(_ tmp: URL) throws {
        var final = Self.modelsDir().appending(path: Self.fileName)
        try? FileManager.default.removeItem(at: final)
        try FileManager.default.moveItem(at: tmp, to: final)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? final.setResourceValues(values)
    }
}

/// URLSession delegate bridging the download task back into async/await.
/// Runs on URLSession's own queue; everything UI-facing hops to the main actor
/// through the injected closures.
private final class DownloadBridge: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let onProgress: (Double) -> Void
    let onResumeData: (Data) -> Void
    var continuation: CheckedContinuation<URL, Error>?
    private var lastReported: Double = 0

    init(onProgress: @escaping (Double) -> Void, onResumeData: @escaping (Data) -> Void) {
        self.onProgress = onProgress
        self.onResumeData = onResumeData
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard totalBytesExpectedToWrite > 0 else { return }
        let p = Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)
        // Throttle main-actor hops to ~200 updates per download.
        if p - lastReported >= 0.005 || p >= 1 {
            lastReported = p
            onProgress(p)
        }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        // The temp file is deleted when this callback returns — move it NOW.
        if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            continuation?.resume(throwing: ModelManager.ModelError.httpError(http.statusCode))
            continuation = nil
            return
        }
        let dest = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString + ".gguf.tmp")
        do {
            try FileManager.default.moveItem(at: location, to: dest)
            continuation?.resume(returning: dest)
        } catch {
            continuation?.resume(throwing: error)
        }
        continuation = nil
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let error else { return }   // success already handled above
        if let data = (error as NSError).userInfo[NSURLSessionDownloadTaskResumeData] as? Data {
            onResumeData(data)
        }
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
