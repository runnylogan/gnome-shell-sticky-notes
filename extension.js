// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 runnylogan
// Sticky Notes — GNOME Shell 50–51 (with Markdown rendering)
// Notes live in a layer above windows and below the top panel, are hidden in
// the Overview, and are stored in ~/.local/share/sticky-notes/notes.json.

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
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {render, toggleTask} from './markdown.js';

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
const ANIM_MS = 220;
const TRASH_MAX = 10;     // closed notes kept for 'Restore last closed note'

function workArea() {
    const index = Main.layoutManager.primaryIndex;
    return global.workspace_manager.get_active_workspace().get_work_area_for_monitor(index);
}

function intersects(a, b, gap = 0) {
    return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap &&
           a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
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
        });

        this._deleteBtn = this._button('window-close-symbolic', 'Delete note');
        this._deleteBtn.connect('clicked', () => this._onDelete());

        header.add_child(colourBtn);
        header.add_child(newBtn);
        header.add_child(dragArea);
        header.add_child(this._deleteBtn);

        // Body: scrollable multi-line entry
        this._entry = new St.Entry({
            style_class: 'sticky-note-text',
            hint_text: 'Write something…',
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
            this.data.text = ct.get_text();
            this._manager.scheduleSave();
        });
        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => {
            const [, symbol] = keys.get_key();
            if (symbol === Clutter.KEY_Escape) {
                global.stage.set_key_focus(null);
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
        content.add_child(this._entry);
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
        this._scroll.set_child(content);
        // Clicking empty space under the text focuses the note at the end;
        // clicks on the text itself are left to the entry.
        const click = new Clutter.ClickGesture();
        click.connect('may-recognize', () => {
            const event = click.get_point_event(0);
            const target = event ? global.stage.get_event_actor(event) : null;
            return !(target && (this._entry.contains(target) || this._view.contains(target)));
        });
        click.connect('recognize', () => this.focus());
        this._scroll.add_action(click);
        // Keep the cursor in view while typing at the end of a long note.
        const vadj = this._scroll.vadjustment;
        vadj.connect('changed', () => {
            if (!ct.has_key_focus())
                return;
            const pos = ct.get_cursor_position();
            if (pos === -1 || pos >= ct.get_text().length)
                vadj.value = Math.max(0, vadj.upper - vadj.page_size);
        });

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
        });
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
        return this._entry.visible;
    }

    _showEditor() {
        this._view.hide();
        this._entry.show();
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
        this._entry.hide();
        this._view.show();
    }

    _onViewClick(gesture) {
        // Work out which displayed line/column was clicked.
        let line = -1, column = -1;
        try {
            const point = gesture.get_point_coords_abs(0);
            const vt = this._view.clutter_text;
            const [ok, lx, ly] = vt.transform_stage_point(point.x, point.y);
            if (ok) {
                const pos = vt.coords_to_position(lx, ly);
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

    _makeDraggable(handle, onMove) {
        const pan = new Clutter.PanGesture();
        pan.set_begin_threshold(0);
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
        });
        const finish = () => {
            if (!this._drag)
                return;
            this._endDrag();
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
        Object.assign(this.data, {
            x: Math.round(geom.x), y: Math.round(geom.y),
            w: Math.round(geom.w), h: Math.round(geom.h),
        });
        const target = {x: this.data.x, y: this.data.y, width: this.data.w, height: this.data.h};
        this.actor.remove_all_transitions();
        if (animate)
            this.actor.ease({...target, duration: ANIM_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this.actor.set(target);
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

        this.menu.addAction('New note', () => ext.newNote());
        this._undelete = this.menu.addAction('Restore last closed note', () => ext.restoreClosed());
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Arrange'));
        this.menu.addAction('Tile', () => ext.arrange('tile'));
        this.menu.addAction('Cascade', () => ext.arrange('cascade'));
        this._restore = this.menu.addAction('Restore previous layout', () => ext.restoreLayout());

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open) {
                this._restore.setSensitive(ext.canRestore);
                const n = ext.closedCount;
                this._undelete.label.text = n > 0
                    ? `Restore last closed note (${n})`
                    : 'Restore last closed note';
                this._undelete.setSensitive(n > 0);
            }
        });
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
        this._connect(global.stage, 'notify::key-focus', () => {
            const focus = global.stage.get_key_focus();
            for (const note of this._notes.values()) {
                const inside = focus && note.actor.contains(focus);
                if (inside)
                    note.raise();
                else if (note.isEditing)
                    note.showRendered();
            }
        });
        this._connect(Main.overview, 'showing', () => this._syncLayer());
        this._connect(Main.overview, 'hidden', () => this._syncLayer());
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
        this._saveNow();

        for (const note of this._notes.values()) {
            Main.layoutManager.untrackChrome(note.actor);
            note.destroy();
        }
        this._notes.clear();
        this._notes = null;

        Main.layoutManager.removeChrome(this._layer);
        this._layer.destroy();
        this._layer = null;

        this._indicator.destroy();
        this._indicator = null;

        this._settings = null;
        this._state = null;
        this._store = null;
    }

    get visible() {
        return this._state.visible;
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
        }
        this._state.arranged = true;

        const area = workArea();
        const geoms = kind === 'tile'
            ? this._tileLayout(notes.length, area)
            : this._cascadeLayout(notes, area);
        notes.forEach((n, i) => {
            n.moveTo(geoms[i]);
            n.raise();
        });
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

    _cascadeLayout(notes, area) {
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
    }

    _connect(obj, signal, cb) {
        this._signals.push([obj, obj.connect(signal, cb)]);
    }
}
