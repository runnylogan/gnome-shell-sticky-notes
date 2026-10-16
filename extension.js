// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 runnylogan
// Sticky Notes — GNOME Shell 50–51 (with Markdown rendering)
// Notes live in a layer above windows and below the top panel, are hidden in
// the Overview, and are stored in ~/.local/share/sticky-notes/notes.json.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fromLiveBullets, liveSpans, render, toLiveBullets, toggleTask} from './markdown.js';

const COLOURS = ['yellow', 'green', 'blue', 'pink', 'purple', 'grey'];
const MIN_W = 160;
const MIN_H = 110;
const DEFAULT_W = 240;
const DEFAULT_H = 200;
const SAVE_DELAY_MS = 600;
const CONFIRM_DELETE_MS = 3000;
const GAP = 16;            // spacing between notes when placing/arranging
const TILE_MAX_W = 420;    // tiled notes never grow beyond this
const TILE_MAX_H = 360;
const CASCADE_STEP = 36;
const HEADER_H = 28;      // note title bar: buttons and drag handle
const SELECT_MIN = 24;    // smallest uncovered patch that still takes a click
const HEADER_LEFT = 56;   // colour and new-note buttons, left of the drag handle
const HEADER_RIGHT = 32;  // close button, right of the drag handle
const ANIM_MS = 220;
const TRASH_MAX = 10;     // closed notes kept for 'Restore Closed'

function workArea() {
    const index = Main.layoutManager.primaryIndex;
    return global.workspace_manager.get_active_workspace().get_work_area_for_monitor(index);
}

function intersects(a, b, gap = 0) {
    return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap &&
           a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(v, hi));
}

function bounds(rects) {
    const x = Math.min(...rects.map(r => r.x));
    const y = Math.min(...rects.map(r => r.y));
    const x2 = Math.max(...rects.map(r => r.x + r.w));
    const y2 = Math.max(...rects.map(r => r.y + r.h));
    return {x, y, w: x2 - x, h: y2 - y};
}

// Stage coordinates of a gesture's first point, from its event (the
// gesture classes' own coordinate getters differ between GNOME versions).
function gesturePoint(gesture) {
    const [x, y] = gesture.get_point_event(0).get_coords();
    return {x, y};
}

// Character position in a ClutterText nearest the actor-relative point
// (lx, ly). coords_to_position() returns a byte offset on GNOME 50, while
// positions everywhere else count characters; read it both ways and keep
// whichever lands closer to the point, so either behaviour works.
function textPositionAt(ct, lx, ly) {
    const raw = ct.coords_to_position(lx, ly);
    if (raw <= 0)
        return raw;
    const bytes = new TextEncoder().encode(ct.get_text());
    const fromBytes = [...new TextDecoder().decode(bytes.slice(0, raw))].length;
    if (fromBytes === raw)
        return raw;
    const distance = pos => {
        const [ok, x, y, lineHeight] = ct.position_to_coords(pos);
        return ok ? Math.abs(y + lineHeight / 2 - ly) * 1000 + Math.abs(x - lx) : Infinity;
    };
    return distance(raw) < distance(fromBytes) ? raw : fromBytes;
}

// '<Super><Alt>n' -> 'Super+Alt+N', for showing a keybinding in the menu.
function shortcutLabel(accel) {
    if (!accel)
        return '';
    const names = {Primary: 'Ctrl', Control: 'Ctrl', Ctrl: 'Ctrl', Shift: 'Shift',
        Alt: 'Alt', Super: 'Super', Meta: 'Meta', Hyper: 'Hyper'};
    // Same modifier order as the preferences window (GTK's).
    const order = ['Shift', 'Ctrl', 'Alt', 'Super', 'Hyper', 'Meta'];
    const mods = [...accel.matchAll(/<(\w+)>/g)].map(m => names[m[1]] ?? m[1])
        .sort((x, y) => order.indexOf(x) - order.indexOf(y));
    let key = accel.replace(/<\w+>/g, '');
    key = key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
    return [...mods, key].join('+');
}

// Byte offset of every UTF-16 index in text (Pango attributes use bytes).
function byteOffsets(text) {
    const offsets = new Array(text.length + 1);
    let bytes = 0;
    for (let i = 0; i < text.length; i++) {
        offsets[i] = bytes;
        const c = text.charCodeAt(i);
        if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
            offsets[++i] = bytes;   // surrogate pair: one 4-byte character
            bytes += 4;
        } else {
            bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
        }
    }
    offsets[text.length] = bytes;
    return offsets;
}

// Mix two Cogl/Clutter colours; t = 0 gives a, 1 gives b. 16-bit channels.
function mixColour(a, b, t) {
    return ['red', 'green', 'blue'].map(c => Math.round((a[c] + (b[c] - a[c]) * t) * 257));
}

// Restyling costs grow with the note; past this, long notes edit as plain
// source so typing stays responsive.
const LIVE_MAX_CHARS = 5000;
const LIVE_HEADING_SCALE = [1.44, 1.2, 1, 1, 1, 1];   // as x-large, large, medium
const LIVE_LINK = [0x1a, 0x5f, 0xb4].map(c => c * 257);

// ---- snapping

const SNAP_DISTANCE = 16;   // how close an edge must be to snap to a target
const SNAP_NEAR = 64;       // notes this close on the other axis are targets

// Snap a note's rect r (moved, or resized from its bottom-right corner) to
// other notes and, if edges, the work area's edges. Each axis snaps on its
// own to the nearest target within SNAP_DISTANCE: alongside another note
// (GAP apart), or lined up with one of its edges. Returns the snapped rect
// and the guide lines to show for it.
function snapRect(r, others, area, {resize = false, edges = true} = {}) {
    const out = {...r};
    const guides = [];
    const axes = [
        {pos: 'x', size: 'w', cross: 'y', crossSize: 'h'},
        {pos: 'y', size: 'h', cross: 'x', crossSize: 'w'},
    ];
    for (const {pos, size, cross, crossSize} of axes) {
        const min = size === 'w' ? MIN_W : MIN_H;
        // The edge being placed: the start when moving, the end when resizing.
        const edge = resize ? r[pos] + r[size] : r[pos];
        const targets = [];   // {edge, line, from} — line is where to draw the guide
        for (const o of others) {
            const gap = Math.max(o[cross] - (r[cross] + r[crossSize]), r[cross] - (o[cross] + o[crossSize]));
            if (gap > SNAP_NEAR)
                continue;
            const start = o[pos], end = o[pos] + o[size];
            if (resize) {
                targets.push({edge: end, line: end, from: o});
                targets.push({edge: start - GAP, line: start - GAP / 2, from: o});
            } else {
                targets.push({edge: start, line: start, from: o});
                targets.push({edge: end - r[size], line: end, from: o});
                targets.push({edge: end + GAP, line: end + GAP / 2, from: o});
                targets.push({edge: start - GAP - r[size], line: start - GAP / 2, from: o});
            }
        }
        if (edges) {
            const start = area[pos], end = area[pos] + area[size];
            targets.push({edge: resize ? end : end - r[size], line: end, from: null});
            if (!resize)
                targets.push({edge: start, line: start, from: null});
        }
        let best = null;
        for (const t of targets) {
            const d = Math.abs(t.edge - edge);
            if (d <= SNAP_DISTANCE && (!best || d < Math.abs(best.edge - edge)))
                best = t;
        }
        if (!best)
            continue;
        if (resize)
            out[size] = Math.max(min, Math.round(best.edge - r[pos]));
        else
            out[pos] = Math.round(best.edge);
        best.axis = {pos, size, cross, crossSize};
        guides.push(best);
    }
    // Draw each guide along the other axis, spanning both notes (or the
    // whole work area for a screen edge), using the snapped rect.
    const lines = guides.map(({line, from, axis: {pos, cross, crossSize}}) => {
        const a = from ? Math.min(out[cross], from[cross]) : area[cross];
        const b = from
            ? Math.max(out[cross] + out[crossSize], from[cross] + from[crossSize])
            : area[cross] + area[crossSize];
        return pos === 'x'
            ? {x: Math.round(line), y: a, w: 0, h: b - a}
            : {x: a, y: Math.round(line), w: b - a, h: 0};
    });
    return {rect: out, lines};
}

function setActorCursor(actor, ...names) {
    // Per-actor cursors (as St.Entry uses for its text cursor). Names are
    // tried in order; fail quietly if this Clutter lacks them.
    try {
        for (const name of names) {
            const type = Clutter.CursorType?.[name];
            if (type !== undefined) {
                actor.set_cursor_type(type);
                return;
            }
        }
    } catch (_e) {}
}

// ---------------------------------------------------------------- storage

class NoteStore {
    constructor() {
        this._dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'sticky-notes']);
        this._path = GLib.build_filenamev([this._dir, 'notes.json']);
    }

    load() {
        const empty = {visible: true, notes: []};
        if (!GLib.file_test(this._path, GLib.FileTest.EXISTS))
            return empty;
        try {
            const [, bytes] = GLib.file_get_contents(this._path);
            const state = JSON.parse(new TextDecoder().decode(bytes));
            if (!Array.isArray(state.notes))
                state.notes = [];
            if (typeof state.visible !== 'boolean')
                state.visible = true;
            return state;
        } catch (e) {
            // Keep the unreadable file rather than overwriting it.
            const backup = `${this._path}.corrupt-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`;
            GLib.rename(this._path, backup);
            console.error(`[sticky-notes] Could not read notes, moved to ${backup}: ${e}`);
            return empty;
        }
    }

    save(state) {
        try {
            GLib.mkdir_with_parents(this._dir, 0o700);
            GLib.file_set_contents(this._path, JSON.stringify(state, null, 2));
        } catch (e) {
            console.error(`[sticky-notes] Could not save notes: ${e}`);
        }
    }
}

// ------------------------------------------------------------------- note

class Note {
    constructor(manager, data) {
        this._manager = manager;
        this.data = data;
        this._drag = null;
        this._grab = null;
        this._confirmId = 0;

        this.actor = new St.BoxLayout({
            style_class: 'sticky-note',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            x: data.x,
            y: data.y,
            width: data.w,
            height: data.h,
        });
        this._applyColour();

        // Header: [colour][new]  drag area  [delete]
        const header = new St.BoxLayout({style_class: 'sticky-note-header', x_expand: true});

        const colourBtn = this._button('color-select-symbolic', 'Change colour');
        colourBtn.connect('clicked', () => this._cycleColour());

        const newBtn = this._button('list-add-symbolic', 'New note');
        newBtn.connect('clicked', () => this._manager.newNote(this));

        const dragArea = new St.Widget({
            style_class: 'sticky-note-drag',
            reactive: true,
            x_expand: true,
        });
        setActorCursor(dragArea, 'MOVE', 'GRAB', 'FLEUR');
        this._makeDraggable(dragArea, (dx, dy, s) => {
            this.actor.set_position(s.x + dx, s.y + dy);
        }, false);

        this._deleteBtn = this._button('window-close-symbolic', 'Delete note');
        this._deleteBtn.connect('clicked', () => this._onDelete());

        header.add_child(colourBtn);
        header.add_child(newBtn);
        header.add_child(dragArea);
        header.add_child(this._deleteBtn);

        // Body: scrollable multi-line entry
        this._entry = new St.Entry({
            style_class: 'sticky-note-text',
            can_focus: true,
            x_expand: true,
        });
        const ct = this._entry.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_activatable(false);
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        ct.set_text(data.text ?? '');
        ct.connect('text-changed', () => {
            if (this._swappingBullets)
                return;
            // Live bullets (•) are only for show: always save plain '-'.
            this.data.text = fromLiveBullets(ct.get_text());
            this._syncHint();
            this._syncLiveStyle(true);
            this._syncTextHeight();
            this.restartBlink();
            this._manager.scheduleSave();
        });
        ct.connect('cursor-changed', () => {
            if (this._swappingBullets)
                return;
            this.restartBlink();
            if (this._syncLiveStyle())
                this._syncTextHeight();
        });
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol === Clutter.KEY_Escape) {
                this._manager.releaseFocus();
                return Clutter.EVENT_STOP;
            }
            // GNOME 51's ClutterText no longer inserts a newline for Enter
            // (it now skips control characters), so insert it here on both.
            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter ||
                symbol === Clutter.KEY_ISO_Enter) {
                ct.delete_selection();
                ct.insert_unichar('\n');
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        ct.add_action(keys);

        // Rendered Markdown, shown whenever the note isn't being edited.
        this._view = new St.Label({
            style_class: 'sticky-note-view',
            x_expand: true,
            reactive: true,
        });
        const vt = this._view.clutter_text;
        vt.set_line_wrap(true);
        vt.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        vt.set_ellipsize(Pango.EllipsizeMode.NONE);
        const viewClick = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_PRIMARY,
            recognize_on_press: true,
        });
        viewClick.connect('recognize', () => this._onViewClick(viewClick));
        this._view.add_action(viewClick);
        this._tasks = new Map();

        const content = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        // The placeholder sits over the top of the text area and ignores
        // clicks, so they reach the text underneath.
        this._hint = new St.Label({
            style_class: 'sticky-note-hint',
            text: 'Write something…',
            reactive: false,
            // BinLayout only honours alignment for expanding children.
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        const editor = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
        });
        editor.add_child(this._entry);
        editor.add_child(this._hint);
        this._editor = editor;
        content.add_child(editor);
        content.add_child(this._view);

        this._scroll = new St.ScrollView({
            style_class: 'sticky-note-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            x_expand: true,
            y_expand: true,
            reactive: true,
        });
        // GNOME 51 adds touch drag-to-scroll, which competes with text
        // selection. Plain assignment is a harmless no-op on GNOME 50, where
        // the property doesn't exist (as a constructor property it throws).
        this._scroll.enable_touch_scrolling = false;
        this._scroll.set_child(content);
        // ClutterText only takes clicks on its characters, so clicks on the
        // empty space around them (all of an empty note) land here: focus
        // the note with the cursor nearest the click. Clicks on the text
        // itself are left to the entry.
        const offText = gesture => {
            const event = gesture.get_point_event(0);
            const target = event ? global.stage.get_event_actor(event) : null;
            const ct = this._entry.clutter_text;
            return !(target && (target === ct || this._view.contains(target)));
        };
        const click = new Clutter.ClickGesture();
        click.connect('may-recognize', () => offText(click));
        click.connect('recognize', () => this._onBodyClick(click));
        this._scroll.add_action(click);
        // Likewise, a drag that starts in that space selects text, from the
        // position nearest where it started to the one nearest the pointer.
        const drag = new Clutter.PanGesture();
        drag.connect('may-recognize', () => this.isEditing && offText(drag));
        drag.connect('recognize', () => {
            const pos = this._textPositionAt(drag.get_begin_centroid_abs());
            this.raise();
            ct.grab_key_focus();
            ct.set_cursor_position(pos);
            ct.set_selection_bound(pos);
        });
        drag.connect('pan-update', () => {
            ct.set_cursor_position(this._textPositionAt(drag.get_centroid_abs()));
        });
        this._scroll.add_action(drag);
        // Stretch the text to fill the visible body, so clicking or starting a
        // selection drag anywhere in the note lands in the text itself.
        const vadj = this._scroll.vadjustment;
        vadj.connect('notify::page-size', () => this._syncTextHeight());
        this._entry.connect('style-changed', () => this._syncTextHeight());
        // St resets the text's attributes on every style change (focus,
        // hover, zoom), so put the live styling back after it has.
        this._entry.connect_after('style-changed', () => this._syncLiveStyle(true));
        ct.connect('notify::width', () => this._syncTextHeight());

        // Keep the cursor in view while typing or moving through a long note.
        ct.connect('cursor-changed', () => this._ensureCursorVisible());
        vadj.connect('changed', () => this._ensureCursorVisible());

        // Footer: resize grip
        const footer = new St.BoxLayout({x_expand: true});
        footer.add_child(new St.Widget({x_expand: true}));
        const grip = new St.Label({
            style_class: 'sticky-note-grip',
            text: '◢',
            reactive: true,
        });
        setActorCursor(grip, 'SE_RESIZE', 'BOTTOM_RIGHT_CORNER');
        this._makeDraggable(grip, (dx, dy, s) => {
            this.actor.set_size(Math.max(MIN_W, s.w + dx), Math.max(MIN_H, s.h + dy));
        }, true);
        footer.add_child(grip);

        this.actor.add_child(header);
        this.actor.add_child(this._scroll);
        this.actor.add_child(footer);

        if (this.data.text?.trim())
            this.showRendered();
        else
            this._showEditor();
    }

    // ---- Markdown view / editor switching

    get isEditing() {
        return this._editor.visible;
    }

    _showEditor() {
        this._view.hide();
        this._editor.show();
        this._syncHint();
        this._syncLiveStyle(true);
    }

    // Live bullets: list markers on lines other than the cursor's are shown
    // as • / ◦ while Live Markdown is on, and as '-' otherwise. The text is
    // never changed from inside ClutterText's own signals (that breaks an
    // insert in progress, e.g. Enter), so the swap waits for an idle moment.
    _queueBullets() {
        if (this._bulletsId)
            return;
        this._bulletsId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._bulletsId = 0;
            const ct = this._entry.clutter_text;
            const text = ct.get_text();
            let target = fromLiveBullets(text);
            if (this._manager.liveMarkdown && this.isEditing && text.length <= LIVE_MAX_CHARS) {
                const pos = ct.get_cursor_position();
                const chars = [...text];
                const cursorLine = (pos < 0 ? chars : chars.slice(0, pos))
                    .filter(c => c === '\n').length;
                target = toLiveBullets(text, cursorLine);
            }
            if (this._setBullets(target)) {
                this._syncLiveStyle(true);
                this._syncTextHeight();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // Swap list markers in the editor's text to match target, which differs
    // from it only by single-character marker swaps (- and • / ◦), so the
    // cursor and selection stay where they are. Returns true if it changed.
    _setBullets(target) {
        const ct = this._entry.clutter_text;
        const current = [...ct.get_text()];
        const wanted = [...target];
        if (current.length !== wanted.length || current.join('') === target)
            return false;
        const cursor = ct.get_cursor_position();
        const bound = ct.get_selection_bound();
        this._swappingBullets = true;
        try {
            current.forEach((c, i) => {
                if (c !== wanted[i]) {
                    ct.delete_text(i, i + 1);
                    ct.insert_text(wanted[i], i);
                }
            });
            ct.set_cursor_position(cursor);
            ct.set_selection_bound(bound);
        } finally {
            this._swappingBullets = false;
        }
        return true;
    }

    // ---- Live Markdown: while editing, style the source in place (lines
    // other than the cursor's look rendered, with the syntax tucked away).
    // Returns true if the styling changed.
    _syncLiveStyle(force = false) {
        const ct = this._entry.clutter_text;
        if (!this._manager.liveMarkdown || !this.isEditing ||
            ct.get_text().length > LIVE_MAX_CHARS) {
            this._queueBullets();
            if (!this._liveKey)
                return false;
            this._liveKey = null;
            // Back to plain text in the theme's colour, as St had it.
            try {
                const fg = this._entry.get_theme_node().get_foreground_color();
                const list = new Pango.AttrList();
                list.insert(Pango.attr_foreground_new(...mixColour(fg, fg, 0)));
                ct.set_attributes(list);
            } catch (_e) {
                ct.set_attributes(null);
            }
            return true;
        }
        const pos = ct.get_cursor_position();
        const chars = [...ct.get_text()];
        const before = pos < 0 ? chars : chars.slice(0, pos);
        const cursorLine = before.filter(c => c === '\n').length;
        this._queueBullets();
        const text = ct.get_text();
        const key = `${cursorLine}\n${text}`;
        if (!force && key === this._liveKey)
            return false;
        this._liveKey = key;

        let fg, bg;
        try {
            fg = this._entry.get_theme_node().get_foreground_color();
            bg = this.actor.get_theme_node().get_background_color();
        } catch (_e) {
            return false;
        }
        const bytes = byteOffsets(text);
        const list = new Pango.AttrList();
        const add = (attr, start, end) => {
            attr.start_index = bytes[start];
            attr.end_index = bytes[end];
            list.insert(attr);
        };
        const colour = (rgb, start, end) => add(Pango.attr_foreground_new(...rgb), start, end);
        // Replacing the attributes drops St's text colour, so restate it.
        colour(mixColour(fg, fg, 0), 0, text.length);
        const muted = mixColour(fg, bg, 0.55);
        for (const span of liveSpans(text, new Set([cursorLine]))) {
            const {start, end} = span;
            let {style} = span;
            // Pango sizes every empty line (and the cursor on it) from the
            // styling at the very start of the text, so syntax there is
            // muted rather than shrunk, or empty lines get a dot of a cursor.
            if (style === 'hide' && start === 0)
                style = 'muted';
            switch (style) {
            case 'hide':
                // Shrink to almost nothing, in the note's own colour.
                add(Pango.attr_scale_new(0.05), start, end);
                colour(mixColour(bg, bg, 0), start, end);
                break;
            case 'muted':
                colour(muted, start, end);
                break;
            case 'bold':
                add(Pango.attr_weight_new(Pango.Weight.BOLD), start, end);
                break;
            case 'italic':
                add(Pango.attr_style_new(Pango.Style.ITALIC), start, end);
                break;
            case 'strike':
                add(Pango.attr_strikethrough_new(true), start, end);
                break;
            case 'code':
                add(Pango.attr_family_new('monospace'), start, end);
                add(Pango.attr_background_new(...mixColour(bg, {red: 0, green: 0, blue: 0}, 0.08)), start, end);
                break;
            case 'link':
                colour(LIVE_LINK, start, end);
                add(Pango.attr_underline_new(Pango.Underline.SINGLE), start, end);
                break;
            case 'box':
                add(Pango.attr_weight_new(Pango.Weight.BOLD), start, end);
                colour(LIVE_LINK, start, end);
                break;
            case 'done':
                add(Pango.attr_strikethrough_new(true), start, end);
                colour(muted, start, end);
                break;
            case 'quote':
                add(Pango.attr_style_new(Pango.Style.ITALIC), start, end);
                colour(muted, start, end);
                break;
            default: {
                const level = Number(style.slice(1));
                add(Pango.attr_weight_new(Pango.Weight.BOLD), start, end);
                add(Pango.attr_scale_new(LIVE_HEADING_SCALE[level - 1]), start, end);
            }
            }
        }
        ct.set_attributes(list);
        return true;
    }

    _syncHint() {
        this._hint.visible = !this._entry.clutter_text.get_text();
    }

    _syncTextHeight() {
        const page = Math.floor(this._scroll.vadjustment.page_size);
        if (!(page > 0))
            return;
        let vpad = 4;
        try {
            const node = this._entry.get_theme_node();
            vpad = node.get_vertical_padding() +
                node.get_border_width(St.Side.TOP) + node.get_border_width(St.Side.BOTTOM);
        } catch (_e) {}
        // Size the entry and its text together: at least the visible body,
        // and tall enough for all the text so the view can scroll. St.Entry
        // otherwise sizes itself to one line and centres the taller text on
        // it, pushing the top of the text out of view.
        const ct = this._entry.clutter_text;
        const h = Math.max(0, page - vpad);
        if (ct.min_height !== h)
            ct.min_height = h;
        const width = ct.width > 0 ? ct.width : -1;
        const [, textH] = ct.get_preferred_height(width);
        const entryH = Math.ceil(Math.max(h, textH) + vpad);
        if (this._entry.min_height !== entryH)
            this._entry.min_height = entryH;
    }

    _ensureCursorVisible() {
        const ct = this._entry.clutter_text;
        if (this._animating || !this.isEditing || !ct.has_key_focus())
            return;
        const vadj = this._scroll.vadjustment;
        let pos = ct.get_cursor_position();
        if (pos < 0)
            pos = [...ct.get_text()].length;
        const [ok, , cy, lineHeight] = ct.position_to_coords(pos);
        if (!ok)
            return;
        // Cursor position in the scrolled content's coordinates.
        const [, ctY] = ct.get_transformed_position();
        const [, viewY] = this._scroll.get_transformed_position();
        const top = ctY - viewY + vadj.value + cy;
        const bottom = top + lineHeight;
        if (top < vadj.value)
            vadj.value = Math.max(0, top);
        else if (bottom > vadj.value + vadj.page_size)
            vadj.value = Math.min(vadj.upper - vadj.page_size, bottom - vadj.page_size);
    }

    // ---- focus indication: darker border plus a blinking cursor

    setFocused(focused, zoom = false) {
        if (focused === this._focused)
            return;
        this._focused = focused;
        if (focused) {
            this.actor.add_style_class_name('focused');
            this.restartBlink();
            if (zoom)
                this._zoomLater();
        } else {
            this.actor.remove_style_class_name('focused');
            this._stopBlink();
            this._cancelZoomLater();
            this.zoomOut();
        }
    }

    // ---- Focus On Edit: temporarily enlarge and centre the note while
    // editing. Its saved position and size are left untouched.

    get zoomed() {
        return !!this._zoomed;
    }

    // Zoom once the click (or menu close) that gave the note focus has been
    // fully handled, so it doesn't race the text's own press handling.
    _zoomLater() {
        this._cancelZoomLater();
        this._zoomId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._zoomId = 0;
            if (this._focused && this._manager.zoomOnEdit)
                this.zoomIn();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelZoomLater() {
        if (this._zoomId) {
            GLib.source_remove(this._zoomId);
            this._zoomId = 0;
        }
    }

    zoomIn() {
        if (this._zoomed)
            return;
        this._zoomed = true;
        this._setMovable(false);
        this.raise();
        const area = workArea();
        const w = Math.round(Math.min(area.width * 0.6, Math.max(this.data.w * 1.8, 560)));
        const h = Math.round(Math.min(area.height * 0.7, Math.max(this.data.h * 1.8, 420)));
        // Grow first, then switch to the larger text, so the text is never
        // laid out against a half-resized note.
        this._animateTo({
            x: Math.round(area.x + (area.width - w) / 2),
            y: Math.round(area.y + (area.height - h) / 2),
            width: w,
            height: h,
        }, () => {
            if (this._zoomed)
                this.actor.add_style_class_name('zoomed');
        });
    }

    zoomOut() {
        if (!this._zoomed)
            return;
        this._clearZoom();
        this._animateTo({x: this.data.x, y: this.data.y, width: this.data.w, height: this.data.h});
    }

    _clearZoom() {
        this._zoomed = false;
        this._setMovable(true);
        this.actor.remove_style_class_name('zoomed');
    }

    _setMovable(movable) {
        for (const pan of this._pans ?? [])
            pan.enabled = movable;
    }

    // While the note is animating, its text sizing and scroll-to-cursor
    // are paused; both are brought up to date once it has settled.
    _animateTo(target, onDone = null) {
        const gen = (this._animGen ?? 0) + 1;
        this._animGen = gen;
        this._animating = true;
        this.actor.remove_all_transitions();
        this.actor.ease({
            ...target,
            duration: ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (gen !== this._animGen)
                    return;
                this._animating = false;
                onDone?.();
                this._settle();
            },
        });
    }

    _setGeometry(target) {
        this._animGen = (this._animGen ?? 0) + 1;
        this._animating = false;
        this.actor.remove_all_transitions();
        this.actor.set(target);
        this._settle();
    }

    _settle() {
        this._syncTextHeight();
        if (!this.isEditing)
            return;
        // Scroll back to the top, then bring the cursor into view.
        this._scroll.vadjustment.value = 0;
        this._ensureCursorVisible();
        this.restartBlink();
    }

    restartBlink() {
        this._stopBlink();
        if (!this._focused)
            return;
        const ct = this._entry.clutter_text;
        ct.cursor_visible = true;
        const blink = this._manager.blinkSettings;
        if (!blink.enabled)
            return;
        const half = Math.max(100, Math.round(blink.time / 2));
        const deadline = GLib.get_monotonic_time() + blink.timeout * 1000000;
        this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, half, () => {
            if (GLib.get_monotonic_time() > deadline) {
                ct.cursor_visible = true;
                this._blinkId = 0;
                return GLib.SOURCE_REMOVE;
            }
            // ClutterText paints the selection with the cursor, so hold
            // steady while something is selected. (Positions can't be
            // compared for this: -1 means the end of the text in both.)
            if (ct.get_selection())
                ct.cursor_visible = true;
            else
                ct.cursor_visible = !ct.cursor_visible;
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopBlink() {
        if (this._blinkId) {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
        }
    }

    showRendered() {
        const text = this.data.text ?? '';
        if (!text.trim()) {
            // Nothing to render: leave the empty editor (with its hint) showing.
            this._showEditor();
            return;
        }
        const {markup, tasks} = render(text);
        this._tasks = tasks;
        let ok = false;
        try {
            // Validate first; malformed markup would blank the label.
            [ok] = Pango.parse_markup(markup, -1, '_');
        } catch (_e) {}
        if (ok) {
            this._view.clutter_text.set_markup(markup);
        } else {
            this._tasks = new Map();
            this._view.clutter_text.set_text(text);
        }
        this._editor.hide();
        this._view.show();
        this._syncLiveStyle();
    }

    // Text position nearest a stage point (-1, the end, if it can't be mapped).
    _textPositionAt(point) {
        const ct = this._entry.clutter_text;
        try {
            const [ok, lx, ly] = ct.transform_stage_point(point.x, point.y);
            if (ok)
                return textPositionAt(ct, lx, ly);
        } catch (e) {
            console.debug(`[sticky-notes] point mapping failed: ${e}`);
        }
        return -1;
    }

    _onBodyClick(gesture) {
        if (!this.isEditing) {
            this.focus();
            return;
        }
        const ct = this._entry.clutter_text;
        const pos = this._textPositionAt(gesturePoint(gesture));
        this.raise();
        ct.grab_key_focus();
        ct.set_cursor_position(pos);
        ct.set_selection_bound(pos);
    }

    _onViewClick(gesture) {
        // Work out which displayed line/column was clicked.
        let line = -1, column = -1;
        try {
            const point = gesturePoint(gesture);
            const vt = this._view.clutter_text;
            const [ok, lx, ly] = vt.transform_stage_point(point.x, point.y);
            if (ok) {
                const pos = textPositionAt(vt, lx, ly);
                const before = [...vt.get_text()].slice(0, pos).join('').split('\n');
                line = before.length - 1;
                column = [...before[before.length - 1]].length;
            }
        } catch (e) {
            console.debug(`[sticky-notes] click mapping failed: ${e}`);
        }

        // Clicking a checkbox ticks it without leaving the rendered view.
        const task = this._tasks.get(line);
        if (task && column >= task.column && column <= task.column + 1) {
            this._entry.clutter_text.set_text(toggleTask(this.data.text, task.line));
            this.showRendered();
            return;
        }
        this.focus(line);
    }

    _button(iconName, label) {
        return new St.Button({
            style_class: 'sticky-note-button',
            can_focus: true,
            accessible_name: label,
            child: new St.Icon({icon_name: iconName, style_class: 'sticky-note-icon'}),
        });
    }

    _makeDraggable(handle, onMove, resize) {
        const pan = new Clutter.PanGesture();
        pan.set_begin_threshold(0);
        this._pans ??= [];
        this._pans.push(pan);
        // Work in absolute stage coordinates: the handle moves with the
        // note, so actor-relative deltas would stay near zero.
        pan.connect('recognize', () => {
            this.raise();
            const start = pan.get_begin_centroid_abs();
            const [w, h] = this.actor.get_size();
            this._drag = {px: start.x, py: start.y, x: this.actor.x, y: this.actor.y, w, h};
            this._grab = global.stage.grab(handle);
        });
        pan.connect('pan-update', () => {
            if (!this._drag)
                return;
            const now = pan.get_centroid_abs();
            onMove(now.x - this._drag.px, now.y - this._drag.py, this._drag);
            this._manager.previewSnap(this, resize);
        });
        const finish = () => {
            if (!this._drag)
                return;
            this._endDrag();
            this._manager.applySnap(this, resize);
            this.clampToScreen();
            this._syncGeometry();
            this._manager.noteMovedByHand();
        };
        pan.connect('end', finish);
        try {
            pan.connect('cancel', finish);
        } catch (_e) {}
        handle.add_action(pan);
    }

    _endDrag() {
        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;
    }

    _syncGeometry() {
        const [w, h] = this.actor.get_size();
        Object.assign(this.data, {
            x: Math.round(this.actor.x),
            y: Math.round(this.actor.y),
            w: Math.round(w),
            h: Math.round(h),
        });
        this._manager.scheduleSave();
    }

    clampToScreen() {
        if (this._zoomed)
            return;
        // Keep at least the header reachable on some monitor.
        const [w] = this.actor.get_size();
        const {x, y} = this.actor;
        const monitors = Main.layoutManager.monitors;
        const onScreen = monitors.some(m =>
            x + w > m.x + 40 && x < m.x + m.width - 40 &&
            y >= m.y && y < m.y + m.height - 40);
        if (onScreen)
            return;
        const m = Main.layoutManager.primaryMonitor;
        const panelH = Main.panel.height ?? 0;
        this.actor.set_position(
            Math.min(Math.max(x, m.x), m.x + m.width - w),
            Math.min(Math.max(y, m.y + panelH), m.y + m.height - MIN_H));
    }

    _applyColour() {
        for (const c of COLOURS)
            this.actor.remove_style_class_name(`sticky-note-${c}`);
        if (!COLOURS.includes(this.data.colour))
            this.data.colour = COLOURS[0];
        this.actor.add_style_class_name(`sticky-note-${this.data.colour}`);
    }

    _cycleColour() {
        const i = COLOURS.indexOf(this.data.colour);
        this.data.colour = COLOURS[(i + 1) % COLOURS.length];
        this._applyColour();
        this._manager.scheduleSave();
    }

    _onDelete() {
        // Empty notes go immediately; others need a second click within 3 s.
        if (!this.data.text?.trim() || this._confirmId) {
            this._manager.deleteNote(this);
            return;
        }
        this._deleteBtn.add_style_class_name('confirm');
        this._confirmId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, CONFIRM_DELETE_MS, () => {
            this._confirmId = 0;
            this._deleteBtn.remove_style_class_name('confirm');
            return GLib.SOURCE_REMOVE;
        });
    }

    moveTo(geom, animate = true) {
        if (this._zoomed)
            this._clearZoom();
        Object.assign(this.data, {
            x: Math.round(geom.x), y: Math.round(geom.y),
            w: Math.round(geom.w), h: Math.round(geom.h),
        });
        const target = {x: this.data.x, y: this.data.y, width: this.data.w, height: this.data.h};
        if (animate)
            this._animateTo(target);
        else
            this._setGeometry(target);
    }

    raise() {
        this.actor.get_parent()?.set_child_above_sibling(this.actor, null);
    }

    // Switch to the editor; with a line number, put the cursor at its end.
    focus(line = -1) {
        this.raise();
        this._showEditor();
        const ct = this._entry.clutter_text;
        ct.grab_key_focus();
        let pos = -1;
        if (line >= 0) {
            const lines = (this.data.text ?? '').split('\n');
            if (line < lines.length) {
                pos = 0;
                for (let i = 0; i <= line; i++)
                    pos += [...lines[i]].length + (i < line ? 1 : 0);
            }
        }
        ct.set_cursor_position(pos);
        ct.set_selection_bound(pos);
    }

    destroy() {
        this._endDrag();
        this._stopBlink();
        if (this._bulletsId) {
            GLib.source_remove(this._bulletsId);
            this._bulletsId = 0;
        }
        this._cancelZoomLater();
        this._animGen = (this._animGen ?? 0) + 1;
        if (this._confirmId) {
            GLib.source_remove(this._confirmId);
            this._confirmId = 0;
        }
        this.actor.destroy();
    }
}

// -------------------------------------------------------------- indicator

const Indicator = GObject.registerClass(
class StickyNotesIndicator extends PanelMenu.Button {
    _init(ext) {
        super._init(0.0, 'Sticky Notes');
        // Replace the default "any click opens the menu" behaviour:
        // left click shows/hides notes, right click opens the menu.
        this.remove_action(this._clickGesture);

        this._icon = new St.Icon({
            icon_name: 'document-edit-symbolic',
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        const left = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY});
        left.connect('recognize', () => {
            this.menu.close();
            ext.togglePanel();
        });
        this.add_action(left);

        const right = new Clutter.ClickGesture({
            required_button: Clutter.BUTTON_SECONDARY,
            recognize_on_press: true,
        });
        right.connect('recognize', () => this.menu.toggle());
        this.add_action(right);

        this._newNote = this._addShortcutItem('New Note', () => ext.newNote());
        this._toggle = this._addShortcutItem('Show/Hide Notes',
            () => ext.setVisible(!ext.visible));
        this._undelete = this.menu.addAction('Restore Closed', () => ext.restoreClosed());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Arrange'));
        this.menu.addAction('Tile', () => ext.arrange('tile'));
        this.menu.addAction('Cascade', () => ext.arrange('cascade'));
        this.menu.addAction('Gather', () => ext.arrange('gather'));
        this._restore = this.menu.addAction('Restore Layout', () => ext.restoreLayout());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Options'));
        this._zoom = new PopupMenu.PopupSwitchMenuItem('Focus On Edit', false);
        this._zoom.connect('toggled', (_item, state) => {
            ext.zoomOnEdit = state;
        });
        this.menu.addMenuItem(this._zoom);
        this._live = new PopupMenu.PopupSwitchMenuItem('Live Markdown', false);
        this._live.connect('toggled', (_item, state) => {
            ext.liveMarkdown = state;
        });
        this.menu.addMenuItem(this._live);
        this._snap = new PopupMenu.PopupSwitchMenuItem('Snap Notes', false);
        this._snap.connect('toggled', (_item, state) => {
            ext.snapNotes = state;
        });
        this.menu.addMenuItem(this._snap);
        this.menu.addAction('Preferences…', () => ext.openPreferences());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._newNote.shortcut.text = ext.shortcut('new-note');
                this._toggle.shortcut.text = ext.shortcut('toggle-notes');
                this._restore.setSensitive(ext.canRestore);
                const n = ext.closedCount;
                this._undelete.label.text = n > 0
                    ? `Restore Closed (${n})`
                    : 'Restore Closed';
                this._undelete.setSensitive(n > 0);
                this._zoom.setToggleState(ext.zoomOnEdit);
                this._live.setToggleState(ext.liveMarkdown);
                this._snap.setToggleState(ext.snapNotes);
            }
        });
    }

    // A menu item with its keyboard shortcut shown on the right.
    _addShortcutItem(label, callback) {
        const item = this.menu.addAction(label, callback);
        item.shortcut = new St.Label({
            style_class: 'sticky-notes-shortcut',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
            opacity: 150,   // dimmed, in whichever colour the menu text is
        });
        item.add_child(item.shortcut);
        return item;
    }

    sync(visible) {
        this._icon.opacity = visible ? 255 : 120;
    }
});

// -------------------------------------------------------------- extension

export default class StickyNotesExtension extends Extension {
    enable() {
        this._store = new NoteStore();
        this._state = this._store.load();
        this._notes = new Map();
        this._saveId = 0;
        this._signals = [];

        // Layer for all notes: above windows, below the top panel and its menus.
        this._layer = new Clutter.Actor({name: 'sticky-notes-layer', reactive: false});
        // Non-reactive, so clicks between notes fall through to windows.
        Main.layoutManager.addChrome(this._layer);
        const ui = Main.layoutManager.uiGroup;
        if (Main.layoutManager.panelBox.get_parent() === ui)
            ui.set_child_below_sibling(this._layer, Main.layoutManager.panelBox);

        for (const data of this._state.notes)
            this._addNote(data);

        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.sync(this.visible);

        this._settings = this.getSettings();
        this._interface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._prevWindow = null;
        const mode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;
        Main.wm.addKeybinding('toggle-notes', this._settings,
            Meta.KeyBindingFlags.NONE, mode, () => this.setVisible(!this.visible));
        Main.wm.addKeybinding('new-note', this._settings,
            Meta.KeyBindingFlags.NONE, mode, () => {
                if (Main.overview.visible)
                    Main.overview.hide();
                this.newNote();
            });

        // Bring a note to the front when its text gets focus.
        // Notes that lose focus go back to rendered Markdown.
        this._connect(global.stage, 'notify::key-focus', () => this._onKeyFocusChanged());
        this._connect(this._settings, 'changed::zoom-on-edit', () => this._onZoomSettingChanged());
        this._connect(this._settings, 'changed::live-markdown', () => {
            for (const note of this._notes.values()) {
                note._syncLiveStyle(true);
                note._syncTextHeight();
            }
        });
        // Clicking into any window hands the keyboard back to it.
        this._connect(global.display, 'notify::focus-window', () => {
            if (global.display.focus_window && this._focusedNote())
                global.stage.set_key_focus(null);
        });
        // Clicking anywhere else outside the notes (the desktop, the panel)
        // leaves the note, as Esc does. The click itself carries on.
        this._connect(global.stage, 'captured-event', (_stage, event) => {
            const type = event.type();
            if ((type === Clutter.EventType.BUTTON_PRESS ||
                 type === Clutter.EventType.TOUCH_BEGIN) && this._focusedNote()) {
                const target = global.stage.get_event_actor(event);
                if (!target || !this._layer.contains(target))
                    this.releaseFocus();
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._connect(Main.overview, 'showing', () => this._syncLayer());
        this._connect(Main.overview, 'hidden', () => this._syncLayer());
        // In the Overview the notes layer is hidden; instead every workspace
        // preview and workspace thumbnail carries a live copy of it. GNOME
        // rebuilds those often (each time the Overview opens, and on every
        // touchpad gesture), so a copy is attached as each one is created.
        // Both classes are the same in GNOME 50 and 51, and are loaded lazily
        // so a change to either can only switch its copies off.
        this._previews = new Map();   // preview or thumbnail -> its copy
        this._injections = new InjectionManager();
        this._injectPreviews('workspace.js', 'WorkspaceBackground',
            bg => this._addBackgroundCopy(bg));
        this._injectPreviews('workspaceThumbnail.js', 'WorkspaceThumbnail',
            thumbnail => this._addThumbnailCopy(thumbnail));
        this._connect(Main.layoutManager, 'monitors-changed', () => {
            for (const note of this._notes.values())
                note.clampToScreen();
        });

        this._syncLayer();
    }

    disable() {
        Main.wm.removeKeybinding('toggle-notes');
        Main.wm.removeKeybinding('new-note');

        for (const [obj, id] of this._signals)
            obj.disconnect(id);
        this._signals = [];

        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
        }
        if (this._focusLaterId) {
            GLib.source_remove(this._focusLaterId);
            this._focusLaterId = 0;
        }
        this._saveNow();

        for (const note of this._notes.values()) {
            Main.layoutManager.untrackChrome(note.actor);
            note.destroy();
        }
        this._notes.clear();
        this._notes = null;

        this._injections.clear();
        this._injections = null;
        for (const copy of [...this._previews.values()])
            copy.destroy();
        this._previews = null;

        Main.layoutManager.removeChrome(this._layer);
        this._layer.destroy();
        this._layer = null;
        this._guides = null;

        this._indicator.destroy();
        this._indicator = null;

        this._settings = null;
        this._interface = null;
        this._prevWindow = null;
        this._state = null;
        this._store = null;
    }

    get visible() {
        return this._state.visible;
    }

    shortcut(key) {
        return shortcutLabel(this._settings.get_strv(key)[0]);
    }

    get snapNotes() {
        return this._settings?.get_boolean('snap-notes') ?? false;
    }

    set snapNotes(value) {
        this._settings.set_boolean('snap-notes', value);
    }

    // ---- snapping (Snap Notes): guides while a note is dragged or
    // resized, and the snap itself when it's let go.

    _snapFor(note, resize) {
        if (!this.snapNotes || (resize && !this._settings.get_boolean('snap-resize')))
            return null;
        const [x, y] = note.actor.get_position();
        const [w, h] = note.actor.get_size();
        const others = [...this._notes.values()]
            .filter(n => n !== note && n.actor.visible)
            .map(n => {
                const [ox, oy] = n.actor.get_position();
                const [ow, oh] = n.actor.get_size();
                return {x: ox, y: oy, w: ow, h: oh};
            });
        const index = Main.layoutManager.findIndexForActor(note.actor);
        const area = Main.layoutManager.getWorkAreaForMonitor(index);
        return snapRect({x, y, w, h}, others, area,
            {resize, edges: this._settings.get_boolean('snap-screen-edges')});
    }

    previewSnap(note, resize) {
        const snap = this._settings.get_boolean('snap-guides') ? this._snapFor(note, resize) : null;
        this._showGuides(snap?.lines ?? []);
    }

    applySnap(note, resize) {
        this._showGuides([]);
        const snap = this._snapFor(note, resize);
        if (!snap)
            return;
        const {x, y, w, h} = snap.rect;
        if (resize)
            note.actor.set_size(w, h);
        else
            note.actor.set_position(x, y);
    }

    _showGuides(lines) {
        this._guides ??= [];
        while (this._guides.length < lines.length) {
            const guide = new St.Widget({style_class: 'sticky-notes-guide', reactive: false});
            this._layer.add_child(guide);
            this._guides.push(guide);
        }
        this._guides.forEach((guide, i) => {
            const line = lines[i];
            guide.visible = !!line;
            if (!line)
                return;
            // 2 px wide, centred on the line.
            guide.set_position(line.w ? line.x : line.x - 1, line.h ? line.y : line.y - 1);
            guide.set_size(line.w || 2, line.h || 2);
            this._layer.set_child_above_sibling(guide, null);
        });
    }

    get liveMarkdown() {
        return this._settings?.get_boolean('live-markdown') ?? false;
    }

    set liveMarkdown(value) {
        this._settings.set_boolean('live-markdown', value);
    }

    get zoomOnEdit() {
        return this._settings.get_boolean('zoom-on-edit');
    }

    set zoomOnEdit(value) {
        this._settings.set_boolean('zoom-on-edit', value);
    }

    _onZoomSettingChanged() {
        const focused = this._focusedNote();
        for (const note of this._notes.values()) {
            if (this.zoomOnEdit && note === focused)
                note.zoomIn();
            else
                note.zoomOut();
        }
    }

    get blinkSettings() {
        return {
            enabled: this._interface.get_boolean('cursor-blink'),
            time: this._interface.get_int('cursor-blink-time'),
            timeout: this._interface.get_int('cursor-blink-timeout'),
        };
    }

    _focusedNote() {
        const focus = global.stage.get_key_focus();
        if (!focus)
            return null;
        for (const note of this._notes.values()) {
            if (note.actor.contains(focus))
                return note;
        }
        return null;
    }

    _onKeyFocusChanged() {
        const focused = this._focusedNote();
        for (const note of this._notes.values()) {
            if (note === focused) {
                note.raise();
                note.setFocused(true, this.zoomOnEdit);
            } else {
                note.setFocused(false);
                if (note.isEditing)
                    note.showRendered();
            }
        }
        // Typing goes to the note while it has focus, so show the app as
        // inactive; remember it so Esc can return to it.
        if (focused && global.display.focus_window) {
            this._prevWindow = global.display.focus_window;
            global.display.unset_input_focus(global.get_current_time());
        }
    }

    // Leave the note (Esc) and give the keyboard back to the previous app.
    releaseFocus() {
        const win = this._prevWindow;
        this._prevWindow = null;
        global.stage.set_key_focus(null);
        if (win) {
            try {
                win.activate(global.get_current_time());
            } catch (_e) {}
        }
    }

    setVisible(visible) {
        this._state.visible = visible;
        this._indicator?.sync(visible);
        this._syncLayer();
        this.scheduleSave();
    }

    togglePanel() {
        if (this._notes.size === 0)
            this.newNote();
        else
            this.setVisible(!this.visible);
    }

    newNote(fromNote = null) {
        const colour = this._nextColour();
        const pos = this._freeSpot(DEFAULT_W, DEFAULT_H, fromNote);
        const data = {
            id: GLib.uuid_string_random(),
            x: pos.x,
            y: pos.y,
            w: DEFAULT_W,
            h: DEFAULT_H,
            colour,
            text: '',
        };
        this._state.notes.push(data);
        const note = this._addNote(data);
        if (!this.visible)
            this.setVisible(true);
        note.focus();
        // Closing the panel menu hands focus back to whatever had it before,
        // so focus the new note again once that has happened.
        if (this._focusLaterId)
            GLib.source_remove(this._focusLaterId);
        this._focusLaterId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._focusLaterId = 0;
            if (this._notes.has(data.id) && this._focusedNote() !== note)
                note.focus();
            return GLib.SOURCE_REMOVE;
        });
        this.scheduleSave();
    }

    _nextColour() {
        const last = this._state.lastColour ??
            this._state.notes[this._state.notes.length - 1]?.colour;
        const i = COLOURS.indexOf(last);
        const colour = COLOURS[(i + 1) % COLOURS.length];
        this._state.lastColour = colour;
        return colour;
    }

    // First position (nearest the preferred point) that overlaps no note.
    _freeSpot(w, h, fromNote) {
        const area = workArea();
        const rects = this._state.notes.map(n => ({x: n.x, y: n.y, w: n.w, h: n.h}));
        const pref = fromNote
            ? {x: fromNote.data.x + fromNote.data.w + GAP, y: fromNote.data.y}
            : {x: area.x + (area.width - w) / 2, y: area.y + (area.height - h) / 3};

        const step = 24;
        const candidates = [];
        for (let y = area.y + GAP; y + h <= area.y + area.height - GAP; y += step) {
            for (let x = area.x + GAP; x + w <= area.x + area.width - GAP; x += step)
                candidates.push({x, y, d: (x - pref.x) ** 2 + (y - pref.y) ** 2});
        }
        candidates.sort((a, b) => a.d - b.d);
        for (const c of candidates) {
            const r = {x: c.x, y: c.y, w, h};
            if (!rects.some(o => intersects(r, o, GAP)))
                return r;
        }
        // Screen full: cascade from the preferred point.
        const offset = (this._notes.size % 8) * 28;
        return {
            x: Math.round(Math.min(pref.x, area.x + area.width - w) + offset),
            y: Math.round(Math.min(pref.y, area.y + area.height - h) + offset),
        };
    }

    // ---- arrangement

    get canRestore() {
        return Array.isArray(this._state.savedLayout) && this._state.savedLayout.length > 0;
    }

    noteMovedByHand() {
        this._state.arranged = false;
    }

    arrange(kind) {
        const notes = this._state.notes.map(d => this._notes.get(d.id)).filter(Boolean);
        if (notes.length === 0)
            return;
        // Keep the hand-made layout from before the first of a run of
        // arrangements, so Tile → Cascade → Restore returns to it.
        if (!this._state.arranged) {
            this._state.savedLayout = notes.map(n => ({
                id: n.data.id, x: n.data.x, y: n.data.y, w: n.data.w, h: n.data.h,
            }));
        } else if (kind !== 'tile' && this.canRestore) {
            // Only Tile resizes notes: the others use the sizes from before
            // the run, not ones an earlier Tile left behind.
            const saved = new Map(this._state.savedLayout.map(g => [g.id, g]));
            for (const n of notes) {
                const g = saved.get(n.data.id);
                if (g) {
                    n.data.w = g.w;
                    n.data.h = g.h;
                }
            }
        }
        this._state.arranged = true;

        const area = workArea();
        let placed;
        if (kind === 'gather') {
            placed = this._gatherLayout(notes, area);
        } else {
            const geoms = kind === 'tile'
                ? this._tileLayout(notes.length, area)
                : this._cascadeLayout(notes, area);
            placed = notes.map((note, i) => ({note, g: geoms[i]}));
        }
        // Stack in layout order, and keep that order across restarts.
        for (const {note, g} of placed) {
            note.moveTo(g);
            note.raise();
        }
        const ids = new Set(placed.map(p => p.note.data.id));
        this._state.notes = [
            ...this._state.notes.filter(d => !ids.has(d.id)),
            ...placed.map(p => p.note.data),
        ];
        if (!this.visible)
            this.setVisible(true);
        this.scheduleSave();
    }

    restoreLayout() {
        if (!this.canRestore)
            return;
        for (const g of this._state.savedLayout) {
            const note = this._notes.get(g.id);
            if (note)
                note.moveTo(g);
        }
        this._state.savedLayout = null;
        this._state.arranged = false;
        if (!this.visible)
            this.setVisible(true);
        this.scheduleSave();
    }

    _tileLayout(n, area) {
        const W = area.width - GAP;
        const H = area.height - GAP;
        // Pick the column count whose cells are closest to a note's shape.
        const target = DEFAULT_W / DEFAULT_H;
        let best = 1, bestScore = Infinity;
        for (let cols = 1; cols <= n; cols++) {
            const rows = Math.ceil(n / cols);
            const ratio = (W / cols) / (H / rows);
            const score = Math.abs(Math.log(ratio / target));
            if (score < bestScore) {
                bestScore = score;
                best = cols;
            }
        }
        const cols = best;
        const rows = Math.ceil(n / cols);
        const cw = Math.max(MIN_W, Math.min(TILE_MAX_W, Math.floor(W / cols) - GAP));
        const ch = Math.max(MIN_H, Math.min(TILE_MAX_H, Math.floor(H / rows) - GAP));
        // Centre the grid in the work area.
        const gridW = cols * (cw + GAP) - GAP;
        const gridH = rows * (ch + GAP) - GAP;
        const x0 = area.x + Math.max(GAP, (area.width - gridW) / 2);
        const y0 = area.y + Math.max(GAP, (area.height - gridH) / 2);
        return Array.from({length: n}, (_, i) => ({
            x: x0 + (i % cols) * (cw + GAP),
            y: y0 + Math.floor(i / cols) * (ch + GAP),
            w: cw,
            h: ch,
        }));
    }

    // Cascade from the top-left, with the step shrunk to fit the screen. If
    // that would leave a note unclickable, fall back to overlapping rows.
    _cascadeLayout(notes, area) {
        const stack = this._centredCascade(notes, area, area.x, area.y);
        if (stack && this._allSelectable(stack.map(p => p.g), area))
            return stack.map(p => p.g);
        return this._stairLayout(notes, area).map(p => p.g);
    }

    // Plain cascade that wraps back to the top-left when it runs out of room.
    _wrapCascade(notes, area) {
        let x = area.x + GAP, y = area.y + GAP;
        return notes.map(n => {
            const w = n.data.w, h = n.data.h;
            if (x + w > area.x + area.width || y + h > area.y + area.height) {
                x = area.x + GAP;
                y = area.y + GAP;
            }
            const g = {x, y, w, h};
            x += CASCADE_STEP;
            y += CASCADE_STEP;
            return g;
        });
    }

    // Gather: keep every note's size and pack them, largest first, as close
    // to the centre as they go without overlapping. Notes that don't fit
    // are cascaded on top. Whatever happens, every note keeps an uncovered
    // patch big enough to click, so none is lost under the others.
    _gatherLayout(notes, area) {
        const cx = area.x + area.width / 2;
        const cy = area.y + area.height / 2;
        const bySize = [...notes].sort((a, b) => b.data.w * b.data.h - a.data.w * a.data.h);
        let placed = [];
        const overflow = [];
        for (const note of bySize) {
            const g = this._nearestFree(note.data.w, note.data.h, placed.map(p => p.g), area, cx, cy);
            if (g)
                placed.push({note, g});
            else
                overflow.push(note);
        }

        // Centre the group as a whole (it fits, so the shift stays on screen).
        if (placed.length > 0) {
            const b = bounds(placed.map(p => p.g));
            const dx = Math.round(clamp(cx - (b.x + b.w / 2),
                area.x + GAP - b.x, area.x + area.width - GAP - (b.x + b.w)));
            const dy = Math.round(clamp(cy - (b.y + b.h / 2),
                area.y + GAP - b.y, area.y + area.height - GAP - (b.y + b.h)));
            placed = placed.map(({note, g}) => ({note, g: {...g, x: g.x + dx, y: g.y + dy}}));
        }
        if (overflow.length === 0)
            return placed;

        // Cascade the rest on top: over the centre if that leaves every note
        // clickable, otherwise beside the group.
        const stack = this._centredCascade(overflow, area, cx, cy);
        if (stack) {
            const s = bounds(stack.map(p => p.g));
            const b = placed.length > 0 ? bounds(placed.map(p => p.g)) : null;
            const anchors = [[cx, cy]];
            if (b) {
                anchors.push(
                    [b.x + b.w + GAP + s.w / 2, cy],
                    [b.x - GAP - s.w / 2, cy],
                    [cx, b.y + b.h + GAP + s.h / 2],
                    [cx, b.y - GAP - s.h / 2]);
            }
            for (const [ax, ay] of anchors) {
                const result = [...placed, ...this._centredCascade(overflow, area, ax, ay)];
                if (this._allSelectable(result.map(p => p.g), area))
                    return result;
            }
        }

        // Too crowded to mix: cascade every note from the centre instead.
        const all = this._centredCascade(bySize, area, cx, cy);
        if (all && this._allSelectable(all.map(p => p.g), area))
            return all;

        // Last resort: rows of overlapping notes, each drag handle uncovered.
        return this._stairLayout(bySize, area);
    }

    // Lay notes out in rows and columns, overlapping only as much as the
    // space requires: each note's drag handle stays clear of the notes to
    // its right and the rows below. When even that won't fit, notes may run
    // off the right or bottom edge, but their handles stay on screen.
    _stairLayout(notes, area) {
        const n = notes.length;
        const handle = HEADER_LEFT + SELECT_MIN;
        const maxW = Math.max(...notes.map(note => note.data.w));
        const maxH = Math.max(...notes.map(note => note.data.h));
        const W = area.width - 2 * GAP, H = area.height - 2 * GAP;
        for (const [spanW, spanH] of [[maxW, maxH], [handle, HEADER_H]]) {
            for (let rows = 1; rows <= n; rows++) {
                const cols = Math.ceil(n / rows);
                const sx = cols > 1 ? Math.floor((W - spanW) / (cols - 1)) : 0;
                const sy = rows > 1 ? Math.floor((H - spanH) / (rows - 1)) : 0;
                if ((cols > 1 && sx < handle) || (rows > 1 && sy < HEADER_H) ||
                    spanW > W || spanH > H)
                    continue;
                const dx = Math.min(sx, maxW + GAP), dy = Math.min(sy, maxH + GAP);
                const gridW = (cols - 1) * dx + maxW, gridH = (rows - 1) * dy + maxH;
                const x0 = area.x + Math.max(GAP, Math.round((area.width - gridW) / 2));
                const y0 = area.y + Math.max(GAP, Math.round((area.height - gridH) / 2));
                return notes.map((note, i) => ({
                    note,
                    g: {
                        x: x0 + (i % cols) * dx,
                        y: y0 + Math.floor(i / cols) * dy,
                        w: note.data.w,
                        h: note.data.h,
                    },
                }));
            }
        }
        // Hundreds of notes on a tiny screen: plain cascade.
        const geoms = this._wrapCascade(notes, area);
        return notes.map((note, i) => ({note, g: geoms[i]}));
    }

    // Free spot for a w×h note nearest (cx, cy), or null if none. Besides a
    // coarse grid, tries spots flush against the notes already placed, so
    // the group packs tightly.
    _nearestFree(w, h, rects, area, cx, cy) {
        const x0 = area.x + GAP, x1 = area.x + area.width - GAP - w;
        const y0 = area.y + GAP, y1 = area.y + area.height - GAP - h;
        if (x1 < x0 || y1 < y0)
            return null;
        const xs = new Set([x0, x1, Math.round(cx - w / 2)]);
        const ys = new Set([y0, y1, Math.round(cy - h / 2)]);
        const step = 32;
        // Measure distance in screen proportions, so the group spreads to
        // the screen's shape rather than into a tall column.
        const aspect = area.width / area.height;
        for (let x = x0; x < x1; x += step)
            xs.add(x);
        for (let y = y0; y < y1; y += step)
            ys.add(y);
        for (const r of rects) {
            for (const x of [r.x + r.w + GAP, r.x - GAP - w, r.x, r.x + r.w - w])
                xs.add(x);
            for (const y of [r.y + r.h + GAP, r.y - GAP - h, r.y, r.y + r.h - h])
                ys.add(y);
        }
        const candidates = [];
        for (const x of xs) {
            if (x < x0 || x > x1)
                continue;
            for (const y of ys) {
                if (y >= y0 && y <= y1)
                    candidates.push({x, y, d: (x + w / 2 - cx) ** 2 + ((y + h / 2 - cy) * aspect) ** 2});
            }
        }
        candidates.sort((a, b) => a.d - b.d);
        for (const c of candidates) {
            const r = {x: c.x, y: c.y, w, h};
            if (!rects.some(o => intersects(r, o, GAP)))
                return r;
        }
        return null;
    }

    // Cascade centred on (ax, ay), with steps shrunk to fit the screen but
    // never below a title bar's height, so each title bar stays uncovered.
    // Returns null if the notes can't be spread that far.
    _centredCascade(notes, area, ax, ay) {
        const n = notes.length;
        const maxW = Math.max(...notes.map(note => note.data.w));
        const maxH = Math.max(...notes.map(note => note.data.h));
        let sx = 0, sy = 0;
        if (n > 1) {
            sx = clamp(Math.floor((area.width - 2 * GAP - maxW) / (n - 1)), 0, CASCADE_STEP);
            sy = Math.min(CASCADE_STEP, Math.floor((area.height - 2 * GAP - maxH) / (n - 1)));
            if (sy < HEADER_H)
                return null;
        }
        const spanW = (n - 1) * sx + maxW;
        const spanH = (n - 1) * sy + maxH;
        // Prefer the top-left edge if the stack is wider than the screen.
        const x0 = Math.round(Math.max(area.x + GAP,
            Math.min(ax - spanW / 2, area.x + area.width - GAP - spanW)));
        const y0 = Math.round(Math.max(area.y + GAP,
            Math.min(ay - spanH / 2, area.y + area.height - GAP - spanH)));
        return notes.map((note, i) => ({
            note,
            g: {x: x0 + i * sx, y: y0 + i * sy, w: note.data.w, h: note.data.h},
        }));
    }

    // True if every note (listed bottom to top) keeps an on-screen patch,
    // uncovered by the notes above it, that a click would land on: its drag
    // handle or its body (not just a header button).
    _allSelectable(geoms, area) {
        const c = SELECT_MIN;
        return geoms.every((g, i) => {
            const above = geoms.slice(i + 1);
            const free = r => !above.some(o => intersects(r, o));
            // The left end of the drag handle first, then anywhere else.
            const grip = {x: g.x + HEADER_LEFT, y: g.y, w: c, h: c};
            if (grip.x >= area.x && grip.x + c <= area.x + area.width &&
                grip.y >= area.y && grip.y + c <= area.y + area.height && free(grip))
                return true;
            const left = Math.max(g.x, area.x), right = Math.min(g.x + g.w, area.x + area.width);
            const top = Math.max(g.y, area.y), bottom = Math.min(g.y + g.h, area.y + area.height);
            for (let y = top; y + c <= bottom; y += c / 2) {
                for (let x = left; x + c <= right; x += c / 2) {
                    // Colour and new buttons on the left, close on the right.
                    if (y < g.y + HEADER_H && (x < g.x + HEADER_LEFT || x + c > g.x + g.w - HEADER_RIGHT))
                        continue;
                    if (free({x, y, w: c, h: c}))
                        return true;
                }
            }
            return false;
        });
    }

    get closedCount() {
        return Array.isArray(this._state.trash) ? this._state.trash.length : 0;
    }

    get canUndelete() {
        return this.closedCount > 0;
    }

    // Bring back the most recently closed note, where it was.
    restoreClosed() {
        if (!this.canUndelete)
            return;
        const data = this._state.trash.pop();
        delete data.closedAt;
        this._state.notes.push(data);
        const note = this._addNote(data);
        if (!this.visible)
            this.setVisible(true);
        note.raise();
        this.scheduleSave();
    }

    deleteNote(note) {
        // Keep every closed note so a mis-click can always be undone.
        this._state.trash ??= [];
        this._state.trash.push({...note.data, closedAt: GLib.DateTime.new_now_local().format_iso8601()});
        this._state.trash = this._state.trash.slice(-TRASH_MAX);
        this._notes.delete(note.data.id);
        this._state.notes = this._state.notes.filter(n => n.id !== note.data.id);
        Main.layoutManager.untrackChrome(note.actor);
        note.destroy();
        this.scheduleSave();
    }

    scheduleSave() {
        if (this._saveId)
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._saveNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    _saveNow() {
        if (this._store && this._state)
            this._store.save(this._state);
    }

    _addNote(data) {
        data.id ??= GLib.uuid_string_random();
        data.w = Math.max(MIN_W, data.w ?? DEFAULT_W);
        data.h = Math.max(MIN_H, data.h ?? DEFAULT_H);
        data.x ??= 100;
        data.y ??= 100;
        const note = new Note(this, data);
        this._layer.add_child(note.actor);
        Main.layoutManager.trackChrome(note.actor, {trackFullscreen: true});
        note.clampToScreen();
        this._notes.set(data.id, note);
        return note;
    }

    _syncLayer() {
        this._layer.visible = this._state.visible && !Main.overview.visible;
        for (const copy of this._previews.values())
            copy.visible = this._state.visible;
    }

    // Give every instance of an Overview class a copy of the notes: those
    // created from now on (by wrapping _init) and any that already exist.
    _injectPreviews(file, className, addCopy) {
        import(`resource:///org/gnome/shell/ui/${file}`).then(module => {
            const klass = module[className];
            if (!this._layer || !klass)
                return;
            const ext = this;
            this._injections.overrideMethod(klass.prototype, '_init', original =>
                function (...args) {
                    original.apply(this, args);
                    ext._addCopy(this, addCopy);
                });
            const find = actor => {
                if (actor instanceof klass)
                    this._addCopy(actor, addCopy);
                else
                    actor.get_children().forEach(find);
            };
            find(Main.layoutManager.overviewGroup);
        }).catch(e => console.warn(`[sticky-notes] No notes in the Overview's ${className}: ${e}`));
    }

    _addCopy(target, addCopy) {
        if (!this._previews || this._previews.has(target))
            return;
        try {
            const copy = addCopy(target);
            if (!copy)
                return;
            copy.visible = this._state.visible;
            copy.connect('destroy', () => this._previews?.delete(target));
            this._previews.set(target, copy);
        } catch (e) {
            console.warn(`[sticky-notes] Couldn't show notes in the Overview: ${e}`);
        }
    }

    // A workspace preview: its background group stands for the whole
    // monitor (top bar cropped off above) but is stretched to the preview's
    // shape, so fit the monitor inside it at one scale, centred, keeping the
    // notes' shape and all of them in view.
    _addBackgroundCopy(bg) {
        const monitor = Main.layoutManager.monitors[bg._monitorIndex];
        if (!monitor || !bg._bin || !bg._backgroundGroup)
            return null;
        const holder = new Clutter.Actor({
            name: 'sticky-notes-preview',
            x_expand: true,
            y_expand: true,
        });
        const clone = new Clutter.Clone({source: this._layer});
        holder.add_child(clone);
        const sync = () => {
            const box = bg._backgroundGroup.get_allocation_box();
            const width = box.x2 - box.x1, height = box.y2 - box.y1;
            if (!(width > 0 && height > 0))
                return;   // not laid out yet (e.g. an off-screen workspace)
            const scale = Math.min(width / monitor.width, height / monitor.height);
            clone.set_scale(scale, scale);
            clone.set_position(
                box.x1 + (width - monitor.width * scale) / 2 - monitor.x * scale,
                box.y1 + (height - monitor.height * scale) / 2 - monitor.y * scale);
        };
        bg._backgroundGroup.connectObject('notify::allocation', sync, holder);
        bg._bin.add_child(holder);
        sync();
        return holder;
    }

    // A workspace thumbnail: its contents are laid out in stage coordinates
    // (offset to the work area) inside a scaled viewport, like the window
    // copies in it, so the notes go on top of them at the same offset.
    _addThumbnailCopy(thumbnail) {
        const contents = thumbnail._contents;
        if (!contents || !thumbnail._viewport)
            return null;
        const clone = new Clutter.Clone({source: this._layer, name: 'sticky-notes-preview'});
        const sync = () => clone.set_position(contents.x, contents.y);
        contents.connectObject('notify::x', sync, 'notify::y', sync, clone);
        thumbnail._viewport.add_child(clone);
        sync();
        return clone;
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }
}
