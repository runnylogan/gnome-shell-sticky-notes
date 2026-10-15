# Repository instructions

- Do not add `Co-Authored-By: Claude` trailers, `Claude-Session:` links, or any other Claude/Anthropic attribution to commit messages, pull request descriptions, release notes, README or code comments.
- Target GNOME Shell 50 and 51. Check any new Shell, St, Clutter or Meta API exists in **both** versions before using it (e.g. `StScrollView:enable-touch-scrolling` is 51-only and must not be passed as a constructor property).
- The release zip contains only: `metadata.json`, `extension.js`, `markdown.js`, `stylesheet.css`, `schemas/*.gschema.xml`, `LICENSE` (no compiled schemas).

# Session handoff

Development happens in cloud sessions that can't reach the owner's memory store or local machine. Before ending a session, leave a handoff so it can be synced and then removed:

- On every issue worked in the session, post a comment whose **first line is exactly `<!-- handoff -->`**, followed by:
  - **Asked:** the request(s), quoted as given
  - **Done:** what changed, with commit SHAs
  - **Decisions:** choices made and why
  - **Open:** anything unfinished, untested or needing a decision
  - **Test:** what to check on a real desktop
- Work not tied to an issue: put the same sections in the final commit message body instead.
- Handoff comments are temporary: they are deleted after syncing. Don't put anything in them that must stay on the issue; a permanent "what was implemented" comment, if wanted, is a separate comment without the marker.
