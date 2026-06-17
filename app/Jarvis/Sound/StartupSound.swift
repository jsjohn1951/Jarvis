import AVFoundation

/// Plays the short startup chime once, at app launch.
///
/// The player lives in a `static` property on purpose: an `AVAudioPlayer` that
/// goes out of scope is deallocated mid-playback and you hear nothing, so we keep
/// a strong reference alive for the life of the process — the same reason
/// `KokoroTTSService` retains its `player`.
enum StartupSound {
    // Touched only once, at launch, on the main thread (SwiftUI App.init runs there),
    // so external synchronization is trivially satisfied — no actor isolation needed.
    nonisolated(unsafe) private static var player: AVAudioPlayer?

    static func play() {
        guard let url = Bundle.main.url(forResource: "start_sound", withExtension: "mp3") else { return }
        do {
            let p = try AVAudioPlayer(contentsOf: url)
            p.prepareToPlay()
            player = p
            p.play()
        } catch {
            // A missing or undecodable chime is purely cosmetic — never block launch on it.
        }
    }
}
