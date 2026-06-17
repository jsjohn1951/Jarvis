# Skills

Capabilities Jarvis can perform on request. One entry per skill.

## Create Excel Spreadsheets (.xlsx)

- Library: `openpyxl` (already installed)
- Supports single-sheet and multi-sheet workbooks, styled headers, auto-width columns, frozen panes
- Always use `.xlsx` extension — openpyxl does not support legacy `.xls`
- Save with `wb.save(path)` — nothing writes to disk until this call

### Quick reference

| Task | Code |
|---|---|
| Create workbook | `wb = openpyxl.Workbook()` |
| New sheet | `wb.create_sheet(title="Name")` |
| Append row | `ws.append(["a", "b", "c"])` |
| Bold header | `cell.font = Font(bold=True)` |
| Background fill | `cell.fill = PatternFill("solid", fgColor="RRGGBB")` |
| Column width | `ws.column_dimensions["A"].width = 20` |
| Freeze top row | `ws.freeze_panes = "A2"` |
| Save to Desktop | `wb.save(os.path.expanduser("~/Desktop/file.xlsx"))` |

### Previously generated files

- `Crypto_Market_Review_June2026.xlsx` — 3 sheets: Price Summary, Event Log, Sector Snapshot
- `Students_AbuDhabi.xlsx`
- `example_multisheet.xlsx`, `example_styled.xlsx`

## Control Other Apps' UI

Jarvis can see and act on the app the user is looking at — handled by the **`desktop`** agent.

- **It can see the screen:** desktop commands attach a screenshot, so describe/act on what's visible.
- **Code edits:** prefer editing files on disk (Read/Edit/Write) — the open editor (e.g. VSCode) reflects changes live. This is the reliable path for "change this code".
- **Real UI actions** (click a button, use a menu, type into a non-file app, switch windows): use the `run_applescript` tool with AppleScript `System Events`, e.g.
  `tell application "System Events" to keystroke "s" using command down`.
- **Launch / focus apps:** the `open_target` tool (`open -a "Visual Studio Code"`).
- **Re-check after acting:** the `capture_screen` tool returns a fresh screenshot.
- Actuation runs inside the Jarvis app (it holds the grants). Needs **Automation** (auto-prompts) and, for keystrokes into other apps, **Accessibility** (System Settings ▸ Privacy & Security ▸ Accessibility).
- Example: *"Jarvis, in VSCode add a header comment to this file"* → sees the editor, edits the file on disk.

## Open Apps & Search the Web

Open an app/browser and go straight to the right place — handled by the **`web`** agent via `open_target`.

- Act decisively — open the exact destination, don't ask the user to click:
  - YouTube video: resolve the actual watch URL `https://www.youtube.com/watch?v=<id>` via WebSearch/WebFetch and open it (a watch URL autoplays). Only use a results URL `…/results?search_query=<terms>` when genuinely unsure which video is meant.
  - Weather: an official site like `https://www.weather.gov` or `https://weather.com`.
  - General search: `https://www.google.com/search?q=<terms>`.
- Default browser is Chrome: `open -a "Google Chrome" "<url>"`.
- Example: *"Jarvis, open a video about tornadoes on YouTube"* → finds the best tornado video's watch URL and opens it playing in Chrome.
