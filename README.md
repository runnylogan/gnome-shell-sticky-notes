# Sticky Notes for GNOME Shell

Lightweight sticky notes that sit on your desktop, above windows and below the top bar. Supports GNOME Shell 50 and 51.

![Sticky notes on the GNOME desktop](docs/screenshot.jpg)

## Features

- **Panel icon** — left-click shows or hides all notes (creates one if none exist). Right-click for:
  - New Note, Show/Hide Notes (each with its keyboard shortcut)
  - Restore Closed (last 10 closed notes are kept)
  - Arrange: **Tile**, **Cascade**, **Gather** (groups notes around the centre of the screen at their current size, cascading any that don't fit; every note stays clickable), **Restore Layout**
  - Options: **Focus On Edit** — enlarge and centre a note while you edit it (off by default); **Live Markdown** — while editing, show every line except the one you're on with its Markdown styled in place, and `- ` list items as bullets (off by default; notes are always saved with plain `-`); **Snap Notes** — when you let go of a moved or resized note, line it up with nearby notes (and the screen edges), with guide lines while dragging (off by default); **Preferences…** — change the shortcuts and snapping options
- **Notes** — drag by the top bar, resize from the bottom-right corner, cycle through six colours, **+** to add a note beside the current one, **×** to close (second click within 3 s confirms if the note has text).
- **Placement** — new notes rotate colour automatically and are placed in free space so they don't overlap existing notes.
- **Markdown** — notes render Markdown when not being edited; click to edit, click away or press `Esc` to render. Supports headings, **bold**, *italic*, ~~strikethrough~~, `inline code`, fenced code blocks, bullet and numbered lists, quotes, horizontal rules, links (shown underlined) and task lists — `- [ ]` / `- [x]` checkboxes can be ticked directly in the rendered view.
- **Shortcuts** — `Super`+`Alt`+`N` new note, `Super`+`Alt`+`H` show/hide notes. Both are shown in the menu and can be changed from **Preferences…** (or the Extensions app).
- In the Overview, notes appear (scaled, not clickable) in each workspace preview and workspace thumbnail while they're shown; they're hidden over fullscreen windows.

Notes are stored locally as JSON in `~/.local/share/sticky-notes/notes.json`. Nothing leaves your machine.

## Install

Download `sticky-notes.shell-extension.zip` from the [latest release](https://github.com/runnylogan/gnome-shell-sticky-notes/releases/latest), then:

```bash
gnome-extensions install --force sticky-notes.shell-extension.zip
```

Log out and back in (Wayland), then enable it:

```bash
gnome-extensions enable sticky-notes@runnylogan
```

## Install from source

```bash
git clone https://github.com/runnylogan/gnome-shell-sticky-notes.git
cd gnome-shell-sticky-notes
gnome-extensions pack --force --extra-source=markdown.js --extra-source=prefs.js
gnome-extensions install --force sticky-notes@runnylogan.shell-extension.zip
```

Then log out and back in and enable it as above.

## Licence

GPL-2.0-or-later — see [LICENSE](LICENSE).
