// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 runnylogan
// Preferences: keyboard shortcuts and snapping options.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SNAP_OPTIONS = [
    ['snap-screen-edges', 'Snap to screen edges', 'Line notes up with the edges of the screen too'],
    ['snap-resize', 'Snap when resizing', 'Snap a note’s size to nearby notes when resizing it'],
    ['snap-guides', 'Show guide lines', 'Show where a note will snap while it’s being dragged'],
];

const SHORTCUTS = [
    ['new-note', 'New note'],
    ['toggle-notes', 'Show or hide notes'],
];

// A row showing one keybinding. Activating it waits for a new key
// combination: Esc cancels, Backspace clears the shortcut.
const ShortcutRow = GObject.registerClass(
class StickyNotesShortcutRow extends Adw.ActionRow {
    _init(settings, key, title) {
        super._init({title, activatable: true});
        this._settings = settings;
        this._key = key;

        this._accel = new Gtk.Label({css_classes: ['dim-label']});
        this.add_suffix(this._accel);

        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            tooltip_text: 'Reset to default',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => {
            this._stopEditing();
            this._settings.reset(this._key);
        });
        this.add_suffix(reset);

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, keycode, state) =>
            this._onKeyPressed(keyval, keycode, state));
        this.add_controller(keys);

        this.connect('activated', () => this._startEditing());
        this._changedId = settings.connect(`changed::${key}`, () => this._sync());
        this.connect('destroy', () => settings.disconnect(this._changedId));
        this._sync();
    }

    _sync() {
        const accel = this._settings.get_strv(this._key)[0] ?? '';
        this._accel.label = accel ? Gtk.accelerator_get_label(...Gtk.accelerator_parse(accel).slice(1)) : 'Disabled';
        this.subtitle = '';
    }

    _startEditing() {
        this._editing = true;
        this._accel.label = 'Press a shortcut…';
        this.subtitle = 'Esc to cancel, Backspace to disable';
        this.grab_focus();
    }

    _stopEditing() {
        this._editing = false;
        this._sync();
    }

    _onKeyPressed(keyval, keycode, state) {
        if (!this._editing)
            return Gdk.EVENT_PROPAGATE;
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        if (!mods && keyval === Gdk.KEY_Escape) {
            this._stopEditing();
            return Gdk.EVENT_STOP;
        }
        if (!mods && keyval === Gdk.KEY_BackSpace) {
            this._settings.set_strv(this._key, []);
            this._stopEditing();
            return Gdk.EVENT_STOP;
        }
        // Wait for a non-modifier key, and require a modifier so ordinary
        // typing can't be captured as a global shortcut.
        if (!mods || !Gtk.accelerator_valid(keyval, mods))
            return Gdk.EVENT_STOP;
        const accel = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
        this._settings.set_strv(this._key, [accel]);
        this._stopEditing();
        return Gdk.EVENT_STOP;
    }
});

export default class StickyNotesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'Keyboard Shortcuts',
            description: 'Click a shortcut, then press the new key combination.',
        });
        for (const [key, title] of SHORTCUTS)
            group.add(new ShortcutRow(settings, key, title));
        page.add(group);

        const snapping = new Adw.PreferencesGroup({
            title: 'Snapping',
            description: 'Used when Snap Notes is switched on in the menu.',
        });
        for (const [key, title, subtitle] of SNAP_OPTIONS) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            snapping.add(row);
        }
        page.add(snapping);
        window.add(page);
    }
}
