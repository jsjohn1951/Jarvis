import AppKit

/// A controllable media player and whether it's installed on this Mac. We never run
/// Apple Events against an app that isn't installed — doing so is wasted work and
/// triggers a pointless Automation permission prompt (the Spotify prompt the user
/// kept seeing despite not having Spotify). Shared by NowPlaying and AudioDucker.
struct MediaPlayer {
    let name: String
    let bundleID: String

    static let all: [MediaPlayer] = [
        MediaPlayer(name: "Spotify", bundleID: "com.spotify.client"),
        MediaPlayer(name: "Music", bundleID: "com.apple.Music"),
    ]

    var isInstalled: Bool {
        NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) != nil
    }

    static var installed: [MediaPlayer] { all.filter(\.isInstalled) }
}

/// "What's playing" — current track from Spotify / Apple Music via Apple Events.
/// Returns nil if neither is playing. Reuses the Automation permission AudioDucker uses.
@MainActor
enum NowPlaying {
    static func current() -> String? {
        for player in MediaPlayer.installed {
            let app = player.name
            let src = """
            if application "\(app)" is running then
              tell application "\(app)"
                if player state is playing then return (name of current track) & " — " & (artist of current track)
              end tell
            end if
            """
            var err: NSDictionary?
            if let s = NSAppleScript(source: src)?.executeAndReturnError(&err).stringValue,
               !s.trimmingCharacters(in: .whitespaces).isEmpty {
                return s
            }
        }
        return nil
    }
}
