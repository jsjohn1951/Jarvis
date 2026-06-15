import AppKit

/// "What's playing" — current track from Spotify / Apple Music via Apple Events.
/// Returns nil if neither is playing. Reuses the Automation permission AudioDucker uses.
@MainActor
enum NowPlaying {
    static func current() -> String? {
        for app in ["Spotify", "Music"] {
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
