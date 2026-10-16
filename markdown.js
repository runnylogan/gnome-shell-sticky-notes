// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 runnylogan
// Minimal Markdown → Pango markup renderer for sticky notes.
// Line-based: every source line becomes exactly one displayed line, so a
// click on the rendered text maps straight back to a source line.

const LINK = '#1a5fb4';
const MUTED = '#5e5c64';
const BOX_SIZE = '150%';   // task checkboxes, relative to the text

export function escape(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Inline formatting on a single (unescaped) line.
export function inline(src) {
    // Pull out `code` spans first so their contents are left alone.
    const codes = [];
    let s = src.replace(/`([^`\n]+)`/g, (_m, code) => {
        codes.push(code);
        return `\u0000${codes.length - 1}\u0000`;
    });

    s = escape(s);

    // Links: [text](url) — shown as underlined text.
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g,
        `<span foreground="${LINK}" underline="single">$1</span>`);
    // Bold, then italic, then strikethrough.
    s = s.replace(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^\w])__(?!\s)(.+?)(?<!\s)__(?!\w)/g, '$1<b>$2</b>');
    s = s.replace(/(^|[^*\w])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?!\*)/g, '$1<i>$2</i>');
    s = s.replace(/(^|[^\w])_(?![\s_])([^_\n]+?)(?<!\s)_(?!\w)/g, '$1<i>$2</i>');
    s = s.replace(/~~(?!\s)(.+?)(?<!\s)~~/g, '<s>$1</s>');

    // Restore code spans.
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, i) =>
        `<span font_family="monospace" bgcolor="#000000" bgalpha="9%">${escape(codes[Number(i)])}</span>`);
    return s;
}

const TASK = /^(\s*)[-*+] \[( |x|X)\](\s+|$)(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^\s*(```|~~~)/;

const HEADING_SIZE = ['x-large', 'large', 'medium', 'medium', 'medium', 'medium'];

// Returns {markup, tasks}; tasks maps a displayed line number to the source
// line holding a checkbox, plus the checkbox's character column in the
// displayed line, so clicks can toggle it.
export function render(src) {
    const lines = src.split('\n');
    const out = [];
    const tasks = new Map();
    let inCode = false;

    lines.forEach((line, i) => {
        if (FENCE.test(line)) {
            inCode = !inCode;
            out.push(`<span foreground="${MUTED}" size="small">${inCode ? '┌ code' : '└'}</span>`);
            return;
        }
        if (inCode) {
            out.push(`<span font_family="monospace" bgcolor="#000000" bgalpha="7%">${escape(line) || ' '}</span>`);
            return;
        }

        let m;
        if ((m = line.match(HEADING))) {
            const level = m[1].length;
            out.push(`<span size="${HEADING_SIZE[level - 1]}" weight="bold">${inline(m[2])}</span>`);
        } else if (RULE.test(line)) {
            out.push(`<span foreground="${MUTED}">${'─'.repeat(24)}</span>`);
        } else if ((m = line.match(TASK))) {
            const indent = m[1].replace(/\t/g, '    ');
            const done = m[2] !== ' ';
            // The box glyphs are small at text size, so draw them larger.
            const box = `<span size="${BOX_SIZE}">${done ? '☑' : '☐'}</span>`;
            tasks.set(out.length, {line: i, column: indent.length});
            const body = inline(m[4]);
            out.push(done
                ? `${indent}${box} <span fgalpha="55%"><s>${body}</s></span>`
                : `${indent}${box} ${body}`);
        } else if ((m = line.match(BULLET))) {
            const indent = m[1].replace(/\t/g, '    ');
            const bullet = indent.length >= 2 ? '◦' : '•';
            out.push(`${indent}${bullet} ${inline(m[2])}`);
        } else if ((m = line.match(ORDERED))) {
            out.push(`${m[1]}${m[2]}. ${inline(m[3])}`);
        } else if ((m = line.match(QUOTE))) {
            out.push(`<span foreground="${MUTED}"><i>▍ ${inline(m[1])}</i></span>`);
        } else {
            out.push(inline(line));
        }
    });

    return {markup: out.join('\n'), tasks};
}

// Flip the checkbox on a source line.
export function toggleTask(src, lineIndex) {
    const lines = src.split('\n');
    const line = lines[lineIndex];
    if (line === undefined)
        return src;
    lines[lineIndex] = line.replace(/^(\s*[-*+] \[)( |x|X)(\])/,
        (_m, a, state, b) => `${a}${state === ' ' ? 'x' : ' '}${b}`);
    return lines.join('\n');
}

// ---- live styling while editing
// The editor can't show rendered markup (its text has to stay the source),
// so instead the source is styled in place. liveSpans() returns
// {start, end, style} ranges as string indices into src; styles are 'hide'
// (syntax to tuck away), 'muted' (syntax left visible), 'h1'…'h6', 'bold',
// 'italic', 'strike', 'code', 'link', 'box', 'done' and 'quote'. Lines in
// rawLines (e.g. the cursor's) are left unstyled so they edit as plain text.

function liveInline(line, from, to, add) {
    const taken = [];
    const free = (s, e) => !taken.some(([a, b]) => s < b && a < e);
    const each = (re, fn) => {
        const seg = line.slice(from, to);
        for (const m of seg.matchAll(re)) {
            fn(m, from + m.index, from + m.index + m[0].length);
        }
    };
    // Same patterns as inline(), in the same order.
    each(/`([^`\n]+)`/g, (m, s, e) => {
        taken.push([s, e]);
        add(s, s + 1, 'hide');
        add(s + 1, e - 1, 'code');
        add(e - 1, e, 'hide');
    });
    each(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, s, e) => {
        if (!free(s, e))
            return;
        add(s, s + 1, 'hide');
        add(s + 1, s + 1 + m[1].length, 'link');
        add(s + 1 + m[1].length, e, 'hide');
    });
    const pair = (re, marker, style, lead) => each(re, (m, s, e) => {
        const start = s + (lead ? m[1].length : 0);
        if (!free(start, e))
            return;
        add(start, start + marker, 'hide');
        add(start + marker, e - marker, style);
        add(e - marker, e, 'hide');
    });
    pair(/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, 2, 'bold', false);
    pair(/(^|[^\w])__(?!\s)(.+?)(?<!\s)__(?!\w)/g, 2, 'bold', true);
    pair(/(^|[^*\w])\*(?![\s*])([^*\n]+?)(?<!\s)\*(?!\*)/g, 1, 'italic', true);
    pair(/(^|[^\w])_(?![\s_])([^_\n]+?)(?<!\s)_(?!\w)/g, 1, 'italic', true);
    pair(/~~(?!\s)(.+?)(?<!\s)~~/g, 2, 'strike', false);
}

export function liveSpans(src, rawLines = new Set()) {
    const spans = [];
    let offset = 0;
    let inCode = false;
    for (const [i, line] of src.split('\n').entries()) {
        const add = (s, e, style) => {
            if (e > s)
                spans.push({start: offset + s, end: offset + e, style});
        };
        const raw = rawLines.has(i);
        let m;
        if (FENCE.test(line)) {
            inCode = !inCode;
            if (!raw)
                add(0, line.length, 'muted');
        } else if (inCode) {
            add(0, line.length, 'code');
        } else if (raw) {
            // left as typed
        } else if ((m = line.match(HEADING))) {
            const level = m[1].length;
            const start = line.indexOf(m[2], level);
            add(0, start > 0 ? start : line.length, 'hide');
            if (m[2]) {
                add(start, start + m[2].length, `h${level}`);
                liveInline(line, start, start + m[2].length, add);
                add(start + m[2].length, line.length, 'hide');
            }
        } else if (RULE.test(line)) {
            add(0, line.length, 'muted');
        } else if ((m = line.match(TASK))) {
            const box = m[1].length + 2;
            add(m[1].length, box, 'hide');
            add(box, box + 3, 'box');
            const body = line.length - m[4].length;
            if (m[2] !== ' ')
                add(body, line.length, 'done');
            liveInline(line, body, line.length, add);
        } else if ((m = line.match(LIVE_LIST))) {
            // A '-' still being typed is muted; a live bullet (•, ◦) is shown as is.
            if (!LIVE_MARKERS.includes(line[m[1].length]))
                add(m[1].length, m[1].length + 1, 'muted');
            liveInline(line, line.length - m[2].length, line.length, add);
        } else if ((m = line.match(ORDERED))) {
            add(m[1].length, line.length - m[3].length, 'muted');
            liveInline(line, line.length - m[3].length, line.length, add);
        } else if ((m = line.match(QUOTE))) {
            const body = line.length - m[1].length;
            add(0, body, 'muted');
            add(body, line.length, 'quote');
            liveInline(line, body, line.length, add);
        } else {
            liveInline(line, 0, line.length, add);
        }
        offset += line.length + 1;
    }
    return spans;
}

// ---- live bullets
// With Live Markdown on, a '- ' list marker on any line but the cursor's is
// swapped in the editor's text for a real bullet (•, or ◦ when indented,
// as in the rendered view). The swap is one character for one, so cursor
// positions don't move, and it is always undone for saving, for the
// cursor's line and when editing ends, so notes stay standard Markdown.

const LIVE_MARKERS = ['•', '◦'];
const LIVE_LIST = /^(\s*)[-*+•◦]\s+(.*)$/;
const DASH_ITEM = /^(\s*)- (?!\[[ xX]\](\s|$))/;
const LIVE_ITEM = /^(\s*)[•◦] /;

// Apply fn to each line outside fenced code blocks.
function mapOutsideCode(src, fn) {
    let inCode = false;
    return src.split('\n').map((line, i) => {
        if (FENCE.test(line)) {
            inCode = !inCode;
            return line;
        }
        return inCode ? line : fn(line, i);
    }).join('\n');
}

// Real bullets for '- ' items on every line except keepLine (kept as '-').
export function toLiveBullets(src, keepLine = -1) {
    return mapOutsideCode(src, (line, i) => {
        if (i === keepLine)
            return line.replace(LIVE_ITEM, '$1- ');
        const m = line.match(DASH_ITEM);
        if (!m || RULE.test(line))
            return line;
        const indent = m[1].replace(/\t/g, '    ');
        return `${m[1]}${indent.length >= 2 ? '◦' : '•'}${line.slice(m[1].length + 1)}`;
    });
}

// Back to plain '- ' list markers.
export function fromLiveBullets(src) {
    return mapOutsideCode(src, line => line.replace(LIVE_ITEM, '$1- '));
}
