# Repository instructions

- Do not add `Co-Authored-By: Claude` trailers, `Claude-Session:` links, or any other Claude/Anthropic attribution to commit messages, pull request descriptions, release notes, README or code comments.
- Target GNOME Shell 50 and 51. Check any new Shell, St, Clutter or Meta API exists in **both** versions before using it (e.g. `StScrollView:enable-touch-scrolling` is 51-only and must not be passed as a constructor property).
- The release zip contains only: `metadata.json`, `extension.js`, `markdown.js`, `stylesheet.css`, `schemas/*.gschema.xml`, `LICENSE` (no compiled schemas).
