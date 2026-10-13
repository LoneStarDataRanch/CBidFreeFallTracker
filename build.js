// Builds the bookmarklet from freefall-tracker.js and puts it in README.md's code block.
//   node build.js            update README.md
//   node build.js --print    print the bookmarklet instead
// The code is URL-encoded (as encodeURIComponent, plus ' ( ) * and !) so it can be pasted
// straight into a bookmark's URL field.
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'freefall-tracker.js'), 'utf8');
const bookmarklet = 'javascript:' + encodeURIComponent(src).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

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
}
