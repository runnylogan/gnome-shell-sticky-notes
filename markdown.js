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
