// Builds the bookmarklet from freefall-tracker.js and puts it in README.md's code block and in
// index.html (the drag-to-install page, made from page.html and published with GitHub Pages).
//   node build.js            update README.md and index.html
//   node build.js --print    print the bookmarklet instead
// The code is URL-encoded (as encodeURIComponent, plus ' ( ) * and !) so it can be pasted
// straight into a bookmark's URL field.
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'freefall-tracker.js'), 'utf8');
const bookmarklet = 'javascript:' + encodeURIComponent(src).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function iconVersion() {
    const hash = require('crypto').createHash('sha1');
    for (const f of ['favicon.svg', 'favicon-32.png', 'favicon-180.png']) hash.update(fs.readFileSync(path.join(__dirname, f)));
    return hash.digest('hex').slice(0, 8);
}

if (process.argv.includes('--print')) {
    process.stdout.write(bookmarklet + '\n');
} else {
    const file = path.join(__dirname, 'README.md');
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((l) => l.startsWith('javascript:'));
    if (at < 0) throw new Error('README.md has no javascript: line to replace');
    lines[at] = bookmarklet;
    fs.writeFileSync(file, lines.join('\n'));
    console.log(`README.md updated (${bookmarklet.length} characters)`);

    const version = (/FreeFall Tracker v([\d.]+)/.exec(src) || [])[1] || '';
    const attr = (v) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const page = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8')
        .replace('{{BOOKMARKLET}}', attr(bookmarklet))
        .replace('{{VERSION}}', version)
        // A tag that changes with the icon files, so browsers don't keep an old cached icon.
        .replace(/\{\{ICON_V\}\}/g, iconVersion());
    fs.writeFileSync(path.join(__dirname, 'index.html'), page);
    console.log(`index.html updated (v${version})`);
}
