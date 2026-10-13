// ============================================================
// CigarBid FreeFall Tracker v6.0
// ============================================================
// - No configuration needed. Run on any FreeFall auction page.
// - Follows each price loop: the price falls in even steps for about
//   two minutes, holds briefly at its floor, then resets higher.
//   Shows this loop's low, the last few loop lows, the usual floor,
//   and roughly when (and how low) the current loop will bottom out.
// - Warns when your target is below every loop low seen so far.
// - Set target price and arm/disarm directly in the panel.
// - Session persistence per auction — refresh restores everything.
// - CSV download saves a real file named after the auction.
// - CSV upload lets you load historical data from a previous auction.
// - Multi-tab coordination shows which tab is closest to target.
// - Price drop rate and estimated time to target, within the
//   current loop (resets no longer skew them).
// ============================================================

(() => {

// --- Guard: prevent double-running ---
if (window.__ffTrackerRunning) {
    console.warn('FreeFall Tracker is already running on this page.');
    return;
}
window.__ffTrackerRunning = true;

// ============================================================
// AUCTION NAME + LOT ID
// ============================================================
const getAuctionName = () => {
    // Try various selectors CigarBid might use for the lot/item name
    const candidates = [
        document.querySelector('.lot-title'),
        document.querySelector('.lot-name'),
        document.querySelector('h1.title'),
        document.querySelector('.auction-title'),
        document.querySelector('h1'),
    ];
    for (const el of candidates) {
        const txt = el?.textContent?.trim();
        if (txt && txt.length > 3 && txt.length < 120) return txt;
    }
    // Fall back to page title minus the site name
    return document.title.replace(/[-|–|·].*$/, '').trim() || 'Unknown Auction';
};

const getLotId = () => {
    const url = location.href;
    const patterns = [
        /\/[Ll]ot\/(\d+)/,
        /\/[Aa]uction\/(\d+)/,
        /\/[Ff]all[Aa]uction\/(\d+)/,
        /[?&]id=(\d+)/,
        /\/(\d{4,})/
    ];
    for (const re of patterns) {
        const m = url.match(re);
        if (m) return `ff_tracker_lot_${m[1]}`;
    }
    return `ff_tracker_path_${location.pathname.replace(/\//g, '_')}`;
};

const LOT_ID      = getLotId();
const AUCTION_NAME = getAuctionName();

// Sanitize auction name for use in a filename
const safeAuctionName = () =>
    AUCTION_NAME.replace(/[^a-zA-Z0-9\s\-]/g, '').replace(/\s+/g, '_').slice(0, 60);

const csvFilename = () => {
    const d   = new Date();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
    return `cigarbid_${safeAuctionName()}_${dateStr}.csv`;
};

console.log(`%cTracker: "${AUCTION_NAME}" | Key: ${LOT_ID}`, 'color:#888;');

// ============================================================
// SESSION PERSISTENCE (localStorage, keyed per lot)
// ============================================================
const saveSession = () => {
    try {
        localStorage.setItem(LOT_ID, JSON.stringify({
            lowestSeen:    lowestSeen === Infinity ? null : lowestSeen,
            desiredPrice:  desiredPrice,
            auctionName:   AUCTION_NAME,
            priceHistory:  priceHistory.slice(-200),
            loops:         loops.slice(-LOOPS_KEPT),
            savedAt:       Date.now()
        }));
    } catch(e) { console.warn('FF Tracker: Could not save session:', e); }
};

const loadSession = () => {
    try {
        const raw = localStorage.getItem(LOT_ID);
        if (!raw) return null;
        const data = JSON.parse(raw);
        // Discard sessions older than 4 hours
        if (Date.now() - data.savedAt > 4 * 60 * 60 * 1000) {
            localStorage.removeItem(LOT_ID);
            return null;
        }
        return data;
    } catch(e) { return null; }
};

const clearSession = () => {
    try { localStorage.removeItem(LOT_ID); } catch(e) {}
};

// ============================================================
// STATE
// ============================================================
let lowestSeen      = Infinity;
let priceHistory    = [];         // { price, lowest, date, timestamp, imported? }
let desiredPrice    = null;
let readyToBuy      = false;      // always starts disarmed — intentional safety
let warningPct      = 0.10;
let warningFired    = false;
let targetFired     = false;
let stopped         = false;
let tabId           = Math.random().toString(36).slice(2, 8);
let sessionRestored = false;
let importedPoints  = 0;

// --- Price loops ---
// A loop: the price falls in even steps, holds at its floor, then resets higher.
// loops = completed loops { start, low, startedAt, lowAt, endedAt, steps }
// curLoop = the loop running now; the first one we see is partial (joined midway).
const LOOPS_KEPT = 50;
let loops   = [];
let curLoop = null;

// Restore session
const savedSession = loadSession();
if (savedSession) {
    if (savedSession.lowestSeen !== null)    lowestSeen   = savedSession.lowestSeen;
    if (savedSession.desiredPrice)           desiredPrice = savedSession.desiredPrice;
    if (savedSession.priceHistory?.length)   priceHistory = savedSession.priceHistory;
    if (Array.isArray(savedSession.loops))   loops        = savedSession.loops;
    sessionRestored = true;
    console.log(`%c📂 Session restored: ${priceHistory.length} pts, ${loops.length} loops, low=$${lowestSeen < Infinity ? lowestSeen.toFixed(2) : 'n/a'}, target=$${desiredPrice ? desiredPrice.toFixed(2) : 'not set'}`, 'color:cyan;');
}

// ============================================================
// DOM SELECTORS
// ============================================================
const priceEl    = document.querySelector('.lot-ff .price-amount');
const submitBtn  = document.querySelector('.btn-ff');
const confirmChk = document.querySelector('input[type="checkbox"]');

if (!priceEl) {
    alert('❌ FreeFall Tracker: Price element not found.\nMake sure you are on a FreeFall auction page.');
    window.__ffTrackerRunning = false;
    return;
}

// ============================================================
// BROADCAST CHANNEL — multi-tab
// ============================================================
let bc;
try { bc = new BroadcastChannel('ff_tracker_v6'); } catch(e) { bc = null; }

const broadcastState = (price) => {
    if (!bc || stopped) return;
    try {
        bc.postMessage({
            tabId,
            lotId:    LOT_ID,
            lotName:  AUCTION_NAME.slice(0, 35),
            price,
            lowest:   lowestSeen < Infinity ? lowestSeen : null,
            target:   desiredPrice,
            armed:    readyToBuy,
            dropRate: calcDropRate(),
            url:      location.href
        });
    } catch(e) {}
};

let otherTabs = {};

if (bc) {
    bc.onmessage = (evt) => {
        const d = evt.data;
        if (!d || d.tabId === tabId) return;
        otherTabs[d.tabId] = { ...d, lastSeen: Date.now() };
        // Prune tabs silent for 10+ seconds
        const now = Date.now();
        Object.keys(otherTabs).forEach(id => {
            if (now - otherTabs[id].lastSeen > 10000) delete otherTabs[id];
        });
        updateTabStatus();
    };
}

// ============================================================
// AUDIO
// ============================================================
const playTone = (freq, duration, type = 'sine', vol = 0.3) => {
    try {
        const ctx  = new (window.AudioContext || window.webkitAudioContext)();
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = type;
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(vol, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
    } catch(e) {}
};
const playWarningAlert = () => {
    playTone(660, 0.2);
    setTimeout(() => playTone(660, 0.2), 280);
};
const playTargetAlert = () => {
    playTone(880,  0.15);
    setTimeout(() => playTone(1100, 0.15), 170);
    setTimeout(() => playTone(1320, 0.30), 340);
};

// ============================================================
// BROWSER NOTIFICATION
// ============================================================
const requestNotifPermission = async () => {
    if (Notification.permission === 'default') await Notification.requestPermission();
};
const sendNotification = (title, body) => {
    if (Notification.permission !== 'granted') return;
    try {
        const n = new Notification(title, {
            body,
            icon: 'https://www.cigarbid.com/favicon.ico',
            requireInteraction: true
        });
        n.onclick = () => { window.focus(); n.close(); };
    } catch(e) {}
};
requestNotifPermission();

// ============================================================
// DATE HELPERS
// ============================================================
const getDate = () => {
    const d   = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${pad(d.getMonth()+1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

// ============================================================
// CSV DOWNLOAD — saves a real file to Downloads
// ============================================================
const downloadCSV = () => {
    if (priceHistory.length === 0) {
        alert('No price data to export yet.');
        return;
    }
    const header = 'auction,price,lowest_at_time,delta_from_lowest,imported,date,loop';
    const rows   = priceHistory.map(r =>
        `"${AUCTION_NAME.replace(/"/g, '""')}",${r.price.toFixed(2)},${r.lowest.toFixed(2)},${(r.price - r.lowest).toFixed(2)},${r.imported ? 'yes' : 'no'},"${r.date}",${r.loop ?? ''}`
    );
    const csv    = [header, ...rows].join('\n');
    const blob   = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url    = URL.createObjectURL(blob);
    const a      = document.createElement('a');
    a.href       = url;
    a.download   = csvFilename();
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
    console.log(`%c📥 CSV saved: ${csvFilename()} (${priceHistory.length} rows)`, 'color:cyan;');
};

// ============================================================
// CSV UPLOAD — import historical data from a previous auction
// ============================================================
const importCSV = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const lines  = e.target.result.split('\n').filter(l => l.trim());
            const header = lines[0].toLowerCase();

            // Verify it looks like one of our CSVs
            if (!header.includes('price') || !header.includes('date')) {
                alert('This doesn\'t look like a valid FreeFall Tracker CSV file.');
                return;
            }

            // Parse columns from header
            const cols   = header.split(',').map(c => c.replace(/"/g, '').trim());
            const priceIdx  = cols.indexOf('price');
            const lowestIdx = cols.indexOf('lowest_at_time');
            const dateIdx   = cols.indexOf('date');

            if (priceIdx === -1) {
                alert('Could not find price column in CSV.');
                return;
            }

            let imported = 0;
            const newPoints = [];

            for (let i = 1; i < lines.length; i++) {
                // Handle quoted fields (auction name may have commas)
                const fields = lines[i].match(/(".*?"|[^,]+)(?=,|$)/g)
                    ?.map(f => f.replace(/^"|"$/g, '').trim()) || [];

                const price  = parseFloat(fields[priceIdx]);
                const lowest = lowestIdx !== -1 ? parseFloat(fields[lowestIdx]) : price;
                const date   = dateIdx   !== -1 ? fields[dateIdx] : 'imported';

                if (isNaN(price) || price <= 0) continue;

                newPoints.push({
                    price,
                    lowest:    isNaN(lowest) ? price : lowest,
                    date:      date || 'imported',
                    timestamp: Date.now() - ((lines.length - i) * 2000), // space them 2s apart
                    imported:  true
                });
                imported++;
            }

            if (imported === 0) {
                alert('No valid price rows found in the CSV.');
                return;
            }

            // Prepend imported points before current session data
            priceHistory  = [...newPoints, ...priceHistory.filter(p => !p.imported)];
            importedPoints = imported;

            // Update lowest seen from imported data
            const importedLow = Math.min(...newPoints.map(p => p.price));
            if (importedLow < lowestSeen) lowestSeen = importedLow;

            saveSession();
            updateSparkline();

            const importEl = document.getElementById('ff-import-status');
            if (importEl) {
                importEl.textContent = `✅ ${imported} pts imported from "${file.name}"`;
                importEl.style.color = '#4f4';
                setTimeout(() => { importEl.textContent = ''; }, 5000);
            }

            // Update changes count
            const changesEl = document.getElementById('ff-changes');
            if (changesEl) changesEl.textContent = priceHistory.length;

            console.log(`%c📂 Imported ${imported} price points from "${file.name}". New lowest: $${lowestSeen.toFixed(2)}`, 'color:cyan;');

        } catch(err) {
            alert('Error reading CSV: ' + err.message);
            console.error('CSV import error:', err);
        }
    };
    reader.readAsText(file);
};

// ============================================================
// PRICE LOOPS
// ============================================================
const median = (xs) => {
    const v = xs.filter(Number.isFinite).sort((x, y) => x - y);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

// Called for every live price: follows the current loop and closes it when the price resets.
// Returns the loop number the price belongs to (0 = the first one seen).
const trackLoop = (price, now) => {
    if (curLoop && price > curLoop.last + 0.005) {
        // The price went back up: the loop ended. The first loop seen started before we joined.
        if (!curLoop.partial && curLoop.ticks >= 3) {
            loops.push({ start: curLoop.start, low: curLoop.low, startedAt: curLoop.startedAt,
                lowAt: curLoop.lowAt, endedAt: curLoop.lastAt, steps: curLoop.ticks });
            if (loops.length > LOOPS_KEPT) loops.shift();
        }
        curLoop = null;
        loopCount++;
    }
    if (!curLoop) {
        curLoop = { start: price, low: price, last: price, startedAt: now, lowAt: now, lastAt: now,
            ticks: 0, drops: [], gaps: [], partial: loopCount === 0 };
    }
    if (price < curLoop.last) {
        curLoop.drops.push(curLoop.last - price);
        curLoop.gaps.push(now - curLoop.lastAt);
    }
    if (price < curLoop.low) { curLoop.low = price; curLoop.lowAt = now; }
    // The same price again: the loop is holding at its floor before it resets.
    curLoop.holding = curLoop.ticks > 0 && Math.abs(price - curLoop.last) < 0.005;
    curLoop.last   = price;
    curLoop.lastAt = now;
    curLoop.ticks++;
    return loopCount;
};
let loopCount = 0; // loops seen this session (the first is partial)

// Typical step size and time between steps in the current loop.
const stepInfo = () => {
    if (!curLoop || curLoop.drops.length < 2) return null;
    const step = median(curLoop.drops);
    const gap  = median(curLoop.gaps);
    return step > 0 && gap > 0 ? { step, gap } : null;
};

// Where loops usually bottom out, as a share of their start (needs 2+ complete loops).
const floorShare = () => {
    const shares = loops.filter(l => l.start > 0).map(l => l.low / l.start);
    return shares.length >= 2 ? median(shares) : null;
};

const deepestLoopLow = () => loops.length ? Math.min(...loops.map(l => l.low)) : null;

// This loop's expected floor, and roughly how long until the price gets there.
const floorEstimate = () => {
    const share = floorShare();
    if (!curLoop || share === null) return null;
    // A loop we joined partway through: its real start isn't known, so use the recent loops' usual start.
    const start = curLoop.partial ? median(loops.slice(-5).map(l => l.start)) : curLoop.start;
    const floor = Math.round(start * share * 100) / 100;
    const si = stepInfo();
    const remaining = curLoop.last - floor;
    const secs = si && remaining > 0 ? (remaining / si.step) * si.gap / 1000 : 0;
    return { floor, secs, share };
};

const fmtSecs = (secs) => {
    const mins = Math.floor(secs / 60);
    const s = Math.round(secs - mins * 60);
    return mins > 0 ? `~${mins}m ${s}s` : `~${s}s`;
};

// ============================================================
// PRICE DROP RATE ($/min within the current loop)
// ============================================================
const calcDropRate = () => {
    const si = stepInfo();
    return si ? (si.step / si.gap) * 60000 : null;
};

const formatDropRate = () => {
    const r = calcDropRate();
    if (r === null) return '--';
    return `-$${Math.abs(r).toFixed(2)}/min`;
};

// Time until the price reaches the target in this loop; 'below floor' when this loop won't get there.
const estimateTimeToTarget = () => {
    if (!desiredPrice || !curLoop) return null;
    const si = stepInfo();
    if (!si) return null;
    const current = curLoop.last;
    if (current <= desiredPrice) return 0;
    const fe = floorEstimate();
    if (fe && desiredPrice < fe.floor) return 'below floor';
    const secs = ((current - desiredPrice) / si.step) * si.gap / 1000;
    if (secs > 999 * 60) return null;
    return fmtSecs(secs);
};

// ============================================================
// SPARKLINE
// ============================================================
const SPARK_W   = 188;
const SPARK_H   = 48;
const SPARK_MAX = 80;

const buildSparkline = () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('id', 'ff-spark');
    svg.setAttribute('width', SPARK_W);
    svg.setAttribute('height', SPARK_H);
    svg.style.cssText = 'display:block;margin-top:6px;border-radius:4px;';

    const addEl = (tag, attrs) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        svg.appendChild(el);
        return el;
    };

    addEl('rect', { width: SPARK_W, height: SPARK_H, fill: '#0f0f0f', rx: 3 });

    // Divider line between imported and live data
    addEl('line', { id: 'ff-spark-divider', x1: 0, x2: 0,
        y1: 0, y2: SPARK_H, stroke: '#444', 'stroke-width': 1,
        'stroke-dasharray': '2,2', opacity: 0 });

    // Warning line (orange dashed)
    addEl('line', { id: 'ff-spark-warning', x1: 0, x2: SPARK_W,
        stroke: '#fa0', 'stroke-width': 1, 'stroke-dasharray': '2,4', opacity: 0 });

    // Target line (blue dashed)
    addEl('line', { id: 'ff-spark-target', x1: 0, x2: SPARK_W,
        stroke: '#4af', 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0 });

    // Imported price line (dimmer)
    addEl('polyline', { id: 'ff-spark-imported',
        fill: 'none', stroke: '#4a4a4a', 'stroke-width': 1,
        'stroke-linejoin': 'round', 'stroke-dasharray': '3,2' });

    // Live price line
    addEl('polyline', { id: 'ff-spark-line',
        fill: 'none', stroke: '#4f4', 'stroke-width': 1.5, 'stroke-linejoin': 'round' });

    return svg;
};

const updateSparkline = () => {
    const liveLine  = document.getElementById('ff-spark-line');
    const impLine   = document.getElementById('ff-spark-imported');
    const tgtLine   = document.getElementById('ff-spark-target');
    const wrnLine   = document.getElementById('ff-spark-warning');
    const divLine   = document.getElementById('ff-spark-divider');
    if (!liveLine) return;

    const allPts    = priceHistory.slice(-SPARK_MAX);
    if (allPts.length < 1) return;

    const importedPts = allPts.filter(p => p.imported);
    const livePts     = allPts.filter(p => !p.imported);

    const prices = allPts.map(p => p.price);
    const refs   = desiredPrice
        ? [desiredPrice, desiredPrice * (1 + warningPct)] : [];
    const minP   = Math.min(...prices, ...refs) * 0.97;
    const maxP   = Math.max(...prices, ...refs) * 1.03;
    const range  = maxP - minP || 1;

    const toX = i  => (i / Math.max(allPts.length - 1, 1)) * SPARK_W;
    const toY = p  => SPARK_H - ((p - minP) / range) * (SPARK_H - 4) - 2;

    // Live line
    if (livePts.length >= 1) {
        const liveStart = allPts.length - livePts.length;
        liveLine.setAttribute('points',
            livePts.map((p, i) =>
                `${toX(liveStart + i).toFixed(1)},${toY(p.price).toFixed(1)}`).join(' '));

        const trend = livePts.length > 1
            ? livePts[livePts.length-1].price - livePts[livePts.length-2].price : 0;
        liveLine.setAttribute('stroke', trend < 0 ? '#4f4' : trend > 0 ? '#f55' : '#fa0');
    }

    // Imported line
    if (importedPts.length >= 1) {
        impLine.setAttribute('points',
            importedPts.map((p, i) =>
                `${toX(i).toFixed(1)},${toY(p.price).toFixed(1)}`).join(' '));

        // Divider between imported and live
        if (livePts.length > 0) {
            const divX = toX(importedPts.length - 1).toFixed(1);
            divLine.setAttribute('x1', divX); divLine.setAttribute('x2', divX);
            divLine.setAttribute('opacity', '1');
        }
    } else {
        impLine.setAttribute('points', '');
        divLine.setAttribute('opacity', '0');
    }

    // Reference lines
    if (desiredPrice) {
        const ty = toY(desiredPrice).toFixed(1);
        tgtLine.setAttribute('y1', ty); tgtLine.setAttribute('y2', ty);
        tgtLine.setAttribute('opacity', '0.9');
        const wy = toY(desiredPrice * (1 + warningPct)).toFixed(1);
        wrnLine.setAttribute('y1', wy); wrnLine.setAttribute('y2', wy);
        wrnLine.setAttribute('opacity', '0.6');
    } else {
        tgtLine.setAttribute('opacity', '0');
        wrnLine.setAttribute('opacity', '0');
    }
};

// ============================================================
// MULTI-TAB STATUS
// ============================================================
const updateTabStatus = () => {
    const el = document.getElementById('ff-tab-status');
    if (!el) return;

    const now = Date.now();
    Object.keys(otherTabs).forEach(id => {
        if (now - otherTabs[id].lastSeen > 10000) delete otherTabs[id];
    });

    const tabs = Object.values(otherTabs);
    if (tabs.length === 0) {
        el.innerHTML = '<span style="color:#3a3a3a;">No other tracked tabs</span>';
        return;
    }

    const thisTab = {
        tabId, lotName: AUCTION_NAME.slice(0, 35),
        lowest: lowestSeen < Infinity ? lowestSeen : null,
        target: desiredPrice, armed: readyToBuy, url: location.href
    };

    const allTabs = [thisTab, ...tabs].filter(t => t.target !== null && t.lowest !== null);

    if (allTabs.length === 0) {
        el.innerHTML = `<span style="color:#3a3a3a;">${tabs.length} tab${tabs.length > 1 ? 's' : ''} active — no targets set</span>`;
        return;
    }

    allTabs.forEach(t => { t._gap = t.lowest - t.target; });
    allTabs.sort((a, b) => a._gap - b._gap);
    const best   = allTabs[0];
    const isThis = best.tabId === tabId;

    const gapStr = best._gap >= 0
        ? `$${best._gap.toFixed(2)} above`
        : `<span style="color:#f55;font-weight:bold;">$${Math.abs(best._gap).toFixed(2)} BELOW!</span>`;

    if (isThis) {
        el.innerHTML = `<span style="color:#4f4;">⭐ This tab closest</span> <span style="color:#555;">(${gapStr} target)</span>`;
    } else {
        el.innerHTML = `⭐ <a href="${best.url}" target="_blank"
            style="color:#4af;text-decoration:none;"
            title="${best.lotName}">${best.lotName.slice(0,20)}…</a>
            ${best.armed ? '<span style="color:#f55;"> ⚡</span>' : ''}
            <span style="color:#fa0;"> ${gapStr}</span>`;
    }

    if (tabs.length > 0) {
        el.innerHTML += `<br><span style="color:#3a3a3a;font-size:10px;">${tabs.length} other tab${tabs.length > 1 ? 's' : ''} active</span>`;
    }
};

// ============================================================
// PANEL UI
// ============================================================
const buildUI = () => {
    const panel = document.createElement('div');
    panel.id = 'ff-tracker-panel';
    panel.style.cssText = `
        position:fixed; top:12px; right:12px; z-index:99999;
        background:#1c1c1c; color:#eee;
        font-family:'Courier New',monospace; font-size:12px;
        padding:12px 14px 10px; border-radius:10px;
        border:1px solid #3a3a3a; width:224px;
        box-shadow:0 6px 24px rgba(0,0,0,0.7);
        user-select:none;
    `;

    panel.innerHTML = `
        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
            <span style="color:#555;font-size:11px;"><svg width="30" height="12" viewBox="0 0 44 18" aria-hidden="true" style="vertical-align:-2px;margin-right:6px;"><rect x="1" y="4" width="33" height="10" rx="5" fill="#8b5a2b"/><rect x="7" y="4" width="5" height="10" fill="#d4a62a"/><rect x="33" y="4.5" width="8" height="9" rx="2" fill="#9b9b9b"/><rect x="40" y="5.5" width="2.5" height="7" rx="1.2" fill="#ff6a1a"/></svg>FF Tracker v6</span>
            <span id="ff-armed-badge" style="font-size:10px;padding:2px 7px;border-radius:10px;
                background:#2a2a2a;color:#888;border:1px solid #3a3a3a;">👁 WATCHING</span>
        </div>

        <!-- Auction name -->
        <div style="color:#666;font-size:10px;margin-bottom:6px;white-space:nowrap;
            overflow:hidden;text-overflow:ellipsis;" title="${AUCTION_NAME}">
            ${AUCTION_NAME.slice(0, 32)}${AUCTION_NAME.length > 32 ? '…' : ''}
        </div>

        ${sessionRestored ? `
        <div style="color:#4af;font-size:10px;text-align:center;margin-bottom:6px;
            background:#1a2a3a;border-radius:4px;padding:3px;">
            📂 Restored — ${priceHistory.length} pts, ${loops.length} loops${importedPoints ? ', '+importedPoints+' imported' : ''}
        </div>` : ''}

        <!-- Price block -->
        <div style="background:#111;border-radius:6px;padding:8px 10px;margin-bottom:7px;">
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">Current</span>
                <span id="ff-current" style="color:#fff;font-size:14px;font-weight:bold;">--</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">This loop low</span>
                <span id="ff-loop-low" style="color:#4f4;">--</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;" title="Where this loop should bottom out, from how low the earlier loops went">Usual floor</span>
                <span id="ff-floor" style="color:#4f4;">--</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">Bottom in</span>
                <span id="ff-bottom" style="color:#555;">--</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">Lowest ever</span>
                <span id="ff-lowest" style="color:#4f4;">
                    ${lowestSeen < Infinity ? '$'+lowestSeen.toFixed(2) : '--'}
                </span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">Target</span>
                <span id="ff-target-display" style="color:#4af;">
                    ${desiredPrice ? '$'+desiredPrice.toFixed(2) : 'not set'}
                </span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">Drop rate</span>
                <span id="ff-drop-rate" style="color:#fa0;">--</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px;">
                <span style="color:#555;">Est. target</span>
                <span id="ff-eta" style="color:#555;">--</span>
            </div>
            <div style="display:flex;justify-content:space-between;">
                <span style="color:#555;">Changes</span>
                <span id="ff-changes" style="color:#888;">${priceHistory.length}</span>
            </div>
            <div style="color:#555;font-size:10px;margin-top:5px;">Last loop lows</div>
            <div id="ff-last-lows" style="color:#888;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${loops.length ? loops.slice(-5).map(l => '$' + l.low.toFixed(2)).join(' · ') : '--'}
            </div>
        </div>

        <!-- Sparkline -->
        <div id="ff-spark-wrap"></div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:#3a3a3a;margin-top:2px;">
            <span id="ff-spark-label-imported"></span>
            <span>live ▶</span>
        </div>

        <!-- Alert status -->
        <div id="ff-alert-status" style="font-size:11px;min-height:15px;margin-top:5px;text-align:center;">
            <span style="color:#444;">Set a target price below</span>
        </div>

        <!-- Target price input -->
        <div style="margin-top:7px;background:#111;border-radius:6px;padding:8px 10px;">
            <div style="color:#555;font-size:10px;margin-bottom:5px;">TARGET PRICE</div>
            <div style="display:flex;gap:5px;align-items:center;">
                <span style="color:#4af;line-height:26px;">$</span>
                <input id="ff-price-input" type="number" min="0.01" step="0.01"
                    placeholder="${desiredPrice ? desiredPrice.toFixed(2) : '0.00'}"
                    style="flex:1;background:#1a1a1a;border:1px solid #3a3a3a;border-radius:4px;
                    color:#fff;font-family:'Courier New',monospace;font-size:13px;
                    padding:4px 6px;outline:none;min-width:0;" />
                <button id="ff-set-btn" style="
                    background:#1a3a1a;color:#4f4;border:1px solid #2a5a2a;
                    border-radius:4px;padding:4px 8px;cursor:pointer;font-size:11px;
                    font-family:'Courier New',monospace;">Set</button>
            </div>
            <div style="color:#444;font-size:10px;margin-top:3px;" id="ff-warning-info">
                ${desiredPrice ? `Warning at $${(desiredPrice*(1+warningPct)).toFixed(2)}` : ''}
            </div>
        </div>

        <!-- Arm button -->
        <button id="ff-arm-btn" style="
            width:100%;margin-top:7px;padding:7px 0;border-radius:6px;cursor:pointer;
            font-size:12px;font-weight:bold;font-family:'Courier New',monospace;
            background:#2a2a2a;color:#555;border:1px solid #333;
            transition:all 0.15s;" ${desiredPrice ? '' : 'disabled'}>
            ⚡ Arm Auto-Buy
        </button>

        <!-- Multi-tab -->
        <div style="margin-top:8px;padding-top:6px;border-top:1px solid #252525;
            font-size:11px;line-height:1.5;" id="ff-tab-status">
            <span style="color:#3a3a3a;">No other tracked tabs</span>
        </div>

        <!-- Bottom buttons row 1: CSV download + upload -->
        <div style="display:flex;gap:5px;margin-top:8px;">
            <button id="ff-csv-btn" style="flex:1;background:#1a2a1a;color:#4f4;
                border:1px solid #2a4a2a;border-radius:5px;padding:5px 0;cursor:pointer;
                font-size:11px;font-family:'Courier New',monospace;"
                title="Download CSV to your computer">⬇ Save CSV</button>
            <button id="ff-import-btn" style="flex:1;background:#1a1a2a;color:#88f;
                border:1px solid #2a2a4a;border-radius:5px;padding:5px 0;cursor:pointer;
                font-size:11px;font-family:'Courier New',monospace;"
                title="Load historical data from a previous auction CSV">⬆ Load CSV</button>
        </div>
        <input id="ff-file-input" type="file" accept=".csv" style="display:none;" />
        <div id="ff-import-status" style="font-size:10px;min-height:14px;margin-top:3px;
            text-align:center;color:#555;"></div>

        <!-- Bottom buttons row 2: Clear + Pause + Close -->
        <div style="display:flex;gap:5px;margin-top:5px;">
            <button id="ff-clear-btn" style="flex:1;background:#222;color:#666;
                border:1px solid #333;border-radius:5px;padding:5px 0;cursor:pointer;
                font-size:11px;font-family:'Courier New',monospace;"
                title="Clear saved history for this auction">🗑 Clear</button>
            <button id="ff-stop-btn" style="flex:1;background:#222;color:#666;
                border:1px solid #333;border-radius:5px;padding:5px 0;cursor:pointer;
                font-size:11px;font-family:'Courier New',monospace;">⏸ Pause</button>
            <button id="ff-close-btn" style="flex:1;background:#2a1a1a;color:#f55;
                border:1px solid #4a2a2a;border-radius:5px;padding:5px 0;cursor:pointer;
                font-size:11px;font-family:'Courier New',monospace;"
                title="Close tracker and remove panel">✕ Close</button>
        </div>

        <div style="color:#2a2a2a;font-size:9px;text-align:center;margin-top:5px;">
            ${LOT_ID.replace('ff_tracker_', '')}
        </div>

        <!-- Branding -->
        <div style="margin-top:7px;padding-top:6px;border-top:1px solid #222;text-align:center;">
            <a href="https://lonestardataranch.com" target="_blank" rel="noopener"
                style="color:#888;font-size:10px;text-decoration:none;
                font-family:'Courier New',monospace;letter-spacing:0.03em;"
                onmouseover="this.style.color='#4af'" 
                onmouseout="this.style.color='#888'">
                🤠 Lone Star Data Ranch
            </a>
        </div>
    `;

    document.body.appendChild(panel);
    document.getElementById('ff-spark-wrap').appendChild(buildSparkline());

    if (sessionRestored && priceHistory.length > 1) {
        updateSparkline();
        const impLabel = document.getElementById('ff-spark-label-imported');
        if (impLabel && importedPoints > 0) impLabel.textContent = '◀ imported';
    }

    // ---- Set price ----
    const priceInput = document.getElementById('ff-price-input');
    const setBtn     = document.getElementById('ff-set-btn');
    const armBtn     = document.getElementById('ff-arm-btn');

    const applyTargetPrice = () => {
        const val = parseFloat(priceInput.value);
        if (isNaN(val) || val <= 0) {
            priceInput.style.borderColor = '#f55';
            setTimeout(() => priceInput.style.borderColor = '#3a3a3a', 900);
            return;
        }
        desiredPrice  = val;
        warningFired  = false;
        targetFired   = false;
        priceInput.value       = '';
        priceInput.placeholder = val.toFixed(2);
        priceInput.style.borderColor = '#4f4';
        setTimeout(() => priceInput.style.borderColor = '#3a3a3a', 800);

        document.getElementById('ff-target-display').textContent = `$${val.toFixed(2)}`;
        document.getElementById('ff-warning-info').textContent   =
            `Warning at $${(val * (1 + warningPct)).toFixed(2)}`;

        armBtn.disabled = false;
        updateArmButton();
        updateSparkline();
        saveSession();
        console.log(`%c🎯 Target: $${val.toFixed(2)} | Warning: $${(val*(1+warningPct)).toFixed(2)}`, 'color:cyan;');
    };

    setBtn.addEventListener('click', applyTargetPrice);
    priceInput.addEventListener('keydown', e => { if (e.key === 'Enter') applyTargetPrice(); });

    // ---- Arm / Disarm ----
    const updateArmButton = () => {
        const badge = document.getElementById('ff-armed-badge');
        if (readyToBuy) {
            armBtn.textContent      = '🔴 ARMED — Click to Disarm';
            armBtn.style.background = '#3a1a1a';
            armBtn.style.color      = '#f55';
            armBtn.style.border     = '1px solid #6a2a2a';
            badge.textContent       = '⚡ ARMED';
            badge.style.background  = '#3a1a1a';
            badge.style.color       = '#f55';
            badge.style.border      = '1px solid #6a2a2a';
        } else {
            armBtn.textContent      = '⚡ Arm Auto-Buy';
            armBtn.style.background = '#2a1a1a';
            armBtn.style.color      = desiredPrice ? '#fa0' : '#555';
            armBtn.style.border     = `1px solid ${desiredPrice ? '#5a4a1a' : '#333'}`;
            badge.textContent       = '👁 WATCHING';
            badge.style.background  = '#2a2a2a';
            badge.style.color       = '#888';
            badge.style.border      = '1px solid #3a3a3a';
        }
    };

    armBtn.addEventListener('click', () => {
        if (!desiredPrice) return;
        readyToBuy   = !readyToBuy;
        warningFired = false;
        targetFired  = false;
        updateArmButton();
        console.log(`%c${readyToBuy ? '⚡ ARMED at $'+desiredPrice.toFixed(2) : '👁 Disarmed'}`,
            `color:${readyToBuy ? 'red' : 'cyan'};font-weight:bold;`);
        if (readyToBuy) {
            sendNotification('⚡ FF Tracker Armed',
                `Auto-buy armed at $${desiredPrice.toFixed(2)} — pre-check the confirm checkbox!`);
        }
    });

    // ---- CSV Download ----
    document.getElementById('ff-csv-btn').addEventListener('click', () => {
        downloadCSV();
    });

    // ---- CSV Upload ----
    const fileInput = document.getElementById('ff-file-input');
    document.getElementById('ff-import-btn').addEventListener('click', () => {
        fileInput.click();
    });
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;
        importCSV(file);
        fileInput.value = ''; // reset so same file can be re-imported if needed
    });

    // ---- Clear session ----
    document.getElementById('ff-clear-btn').addEventListener('click', () => {
        if (!confirm(`Clear all saved history for:\n"${AUCTION_NAME}"?`)) return;
        clearSession();
        priceHistory   = [];
        lowestSeen     = Infinity;
        desiredPrice   = null;
        readyToBuy     = false;
        warningFired   = false;
        targetFired    = false;
        importedPoints = 0;
        loops          = [];
        curLoop        = null;
        loopCount      = 0;
        ['ff-lowest','ff-current','ff-target-display','ff-drop-rate','ff-eta','ff-loop-low','ff-floor','ff-bottom','ff-last-lows']
            .forEach(id => { const el = document.getElementById(id); if(el) el.textContent = '--'; });
        document.getElementById('ff-changes').textContent      = '0';
        document.getElementById('ff-warning-info').textContent = '';
        document.getElementById('ff-alert-status').innerHTML   =
            '<span style="color:#444;">Set a target price below</span>';
        priceInput.placeholder = '0.00';
        armBtn.disabled = true;
        updateArmButton();
        updateSparkline();
        console.log('%c🗑 Session cleared', 'color:#f55;');
    });

    // ---- Pause / Resume ----
    document.getElementById('ff-stop-btn').addEventListener('click', () => {
        if (paused) resumeTracker(); else pauseTracker();
    });

    // ---- Close ----
    document.getElementById('ff-close-btn').addEventListener('click', closeTracker);

    // ---- Draggable panel ----
    let dragging = false, ox = 0, oy = 0;
    panel.addEventListener('mousedown', e => {
        if (['INPUT','BUTTON'].includes(e.target.tagName)) return;
        dragging = true;
        const r = panel.getBoundingClientRect();
        ox = e.clientX - r.left; oy = e.clientY - r.top;
        panel.style.cursor = 'grabbing';
    });
    document.addEventListener('mousemove', e => {
        if (!dragging) return;
        panel.style.left  = (e.clientX - ox) + 'px';
        panel.style.top   = (e.clientY - oy) + 'px';
        panel.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => {
        dragging = false; panel.style.cursor = 'default';
    });
};

// ============================================================
// UPDATE UI
// ============================================================
const updateUI = (current) => {
    const $ = id => document.getElementById(id);
    if (!$('ff-current')) return;

    const pctAboveLow = lowestSeen < Infinity
        ? ((current - lowestSeen) / lowestSeen * 100).toFixed(1) : null;
    $('ff-current').textContent =
        `$${current.toFixed(2)}${pctAboveLow !== null ? ' (+'+pctAboveLow+'%)' : ''}`;
    $('ff-lowest').textContent  = lowestSeen < Infinity ? `$${lowestSeen.toFixed(2)}` : '--';
    $('ff-changes').textContent = priceHistory.length;

    // Loops
    if (curLoop) $('ff-loop-low').textContent = `$${curLoop.low.toFixed(2)}`;
    const fe = floorEstimate();
    $('ff-floor').textContent = fe
        ? `~$${fe.floor.toFixed(2)} (${Math.round(fe.share * 100)}%)`
        : (loops.length ? 'after 2 loops' : 'after 1st full loop');
    const bottomEl = $('ff-bottom');
    if (curLoop && curLoop.holding) {
        bottomEl.textContent = `holding at $${curLoop.low.toFixed(2)}`;
        bottomEl.style.color = '#4f4';
    } else if (fe && fe.secs > 0) {
        bottomEl.textContent = fmtSecs(fe.secs);
        bottomEl.style.color = fe.secs <= 20 ? '#4f4' : '#fa0';
    } else {
        bottomEl.textContent = fe ? 'at the floor' : '--';
        bottomEl.style.color = fe ? '#4f4' : '#555';
    }
    $('ff-last-lows').textContent = loops.length ? loops.slice(-5).map(l => '$' + l.low.toFixed(2)).join(' · ') : '--';

    // Drop rate
    const drEl   = $('ff-drop-rate');
    const rate   = calcDropRate();
    if (drEl) {
        drEl.textContent = formatDropRate();
        drEl.style.color = rate === null ? '#555'
            : rate > 0 ? '#4f4' : rate < 0 ? '#f55' : '#555';
    }

    // ETA
    const etaEl = $('ff-eta');
    if (etaEl) {
        const eta = estimateTimeToTarget();
        etaEl.textContent = eta === 0 ? 'now' : (eta !== null ? eta : (desiredPrice ? 'n/a' : '--'));
        etaEl.style.color = eta === 'below floor' ? '#f55' : (eta !== null ? '#fa0' : '#555');
    }

    // Color current price vs lowest
    let color = '#fff';
    if (lowestSeen < Infinity) {
        const ratio = current / lowestSeen;
        if      (ratio <= 1.05) color = '#4f4';
        else if (ratio <= 1.10) color = '#cf4';
        else if (ratio <= 1.20) color = '#fa0';
        else                    color = '#f55';
    }
    $('ff-current').style.color = color;

    // Alert status
    const alertEl = $('ff-alert-status');
    if (alertEl) {
        if (!desiredPrice) {
            alertEl.innerHTML = '<span style="color:#444;">Set a target price below</span>';
        } else if (current <= desiredPrice) {
            alertEl.innerHTML = '<span style="color:#4f4;font-weight:bold;">🎯 TARGET HIT!</span>';
        } else if (loops.length >= 3 && desiredPrice < deepestLoopLow()) {
            alertEl.innerHTML = `<span style="color:#f55;">⚠️ Below every loop low so far (deepest $${deepestLoopLow().toFixed(2)})</span>`;
        } else if (current <= desiredPrice * (1 + warningPct)) {
            const pctAway = (((current - desiredPrice) / desiredPrice) * 100).toFixed(1);
            alertEl.innerHTML = `<span style="color:#fa0;">⚠️ ${pctAway}% above target</span>`;
        } else {
            alertEl.innerHTML = `<span style="color:#555;">$${(current - desiredPrice).toFixed(2)} above target</span>`;
        }
    }

    // Flash border on new low
    if (current <= lowestSeen) {
        const p = $('ff-tracker-panel');
        if (p) {
            p.style.border = '1px solid #4f4';
            setTimeout(() => { if (p) p.style.border = '1px solid #3a3a3a'; }, 600);
        }
    }

    updateSparkline();
    updateTabStatus();
};

// ============================================================
// PAUSE / RESUME / CLOSE
// ============================================================
let paused = false;

const pauseTracker = () => {
    paused = true;
    observer.disconnect();
    saveSession();
    const stopBtn = document.getElementById('ff-stop-btn');
    const panel   = document.getElementById('ff-tracker-panel');
    const badge   = document.getElementById('ff-armed-badge');
    if (stopBtn) { stopBtn.textContent = '▶ Resume'; stopBtn.style.color = '#fa0'; stopBtn.style.borderColor = '#5a4a1a'; }
    if (panel)   panel.style.border = '1px solid #5a4a1a';
    if (badge)   { badge.textContent = '⏸ PAUSED'; badge.style.color = '#fa0'; badge.style.background = '#2a2a1a'; badge.style.border = '1px solid #5a4a1a'; }
    console.log('%c⏸ Tracker paused — session saved.', 'color:#fa0;');
};

const resumeTracker = () => {
    paused = false;
    observer.observe(priceEl, { attributes: true, childList: true, subtree: true });
    const stopBtn = document.getElementById('ff-stop-btn');
    const panel   = document.getElementById('ff-tracker-panel');
    const badge   = document.getElementById('ff-armed-badge');
    if (stopBtn) { stopBtn.textContent = '⏸ Pause'; stopBtn.style.color = '#666'; stopBtn.style.borderColor = '#333'; }
    if (panel)   panel.style.border = '1px solid #3a3a3a';
    if (badge) {
        if (readyToBuy) {
            badge.textContent = '⚡ ARMED'; badge.style.color = '#f55';
            badge.style.background = '#3a1a1a'; badge.style.border = '1px solid #6a2a2a';
        } else {
            badge.textContent = '👁 WATCHING'; badge.style.color = '#888';
            badge.style.background = '#2a2a2a'; badge.style.border = '1px solid #3a3a3a';
        }
    }
    console.log('%c▶ Tracker resumed.', 'color:cyan;');
};

const closeTracker = () => {
    stopped = true;
    observer.disconnect();
    if (bc) { try { bc.close(); } catch(e) {} }
    saveSession();
    window.__ffTrackerRunning = false;
    const panel = document.getElementById('ff-tracker-panel');
    if (panel) panel.remove();
    const inlineTimer = document.getElementById('ff-inline-timer');
    if (inlineTimer) inlineTimer.remove();
    console.log('%c✕ Tracker closed — session saved.', 'color:#f55;');
    console.log(`Lowest: $${lowestSeen < Infinity ? lowestSeen.toFixed(2) : 'n/a'} | Target: $${desiredPrice ? desiredPrice.toFixed(2) : 'not set'} | ${priceHistory.length} total changes`);
};

// Keep stopTracker as alias for closeTracker for obsDisconnect() console command
const stopTracker = closeTracker;

// ============================================================
// MUTATION OBSERVER
// ============================================================
const cb = (mutations) => {
    const raw = mutations[0]?.target?.dataset?.value;
    if (!raw) return;
    const current = parseFloat(raw);
    if (isNaN(current)) return;

    const isNewLow = current < lowestSeen;
    if (isNewLow) lowestSeen = current;
    const now = Date.now();
    const loopsBefore = loops.length;
    const loopNo = trackLoop(current, now);
    if (loops.length > loopsBefore) {
        const l = loops[loops.length - 1];
        console.log(`%c↺ Loop ended: $${l.start.toFixed(2)} → low $${l.low.toFixed(2)} (${Math.round(l.low / l.start * 100)}%), ${Math.round((l.endedAt - l.startedAt) / 1000)}s`, 'color:#88f;');
    }

    priceHistory.push({
        price:     current,
        lowest:    lowestSeen,
        date:      getDate(),
        timestamp: now,
        imported:  false,
        loop:      loopNo
    });

    saveSession();

    console.log(
        isNewLow
            ? `%c[NEW LOW] $${current.toFixed(2)} | ${getDate()}`
            : `[      ] $${current.toFixed(2)} | Low: $${lowestSeen.toFixed(2)} | ${getDate()}`,
        isNewLow ? 'color:lime;font-weight:bold;' : ''
    );

    if (desiredPrice) {
        const warnPrice = desiredPrice * (1 + warningPct);

        if (!warningFired && current <= warnPrice && current > desiredPrice) {
            warningFired = true;
            playWarningAlert();
            sendNotification(
                `⚠️ Getting Close! $${current.toFixed(2)}`,
                `Within ${(warningPct*100).toFixed(0)}% of target on "${AUCTION_NAME}"`
            );
        }

        if (!targetFired && current <= desiredPrice) {
            targetFired = true;
            playTargetAlert();
            sendNotification(
                `🎯 TARGET HIT — $${current.toFixed(2)}`,
                readyToBuy
                    ? '⚡ Auto-buy triggered! CHECK THE CONFIRM CHECKBOX!'
                    : `👁 Watch mode on "${AUCTION_NAME}"`
            );
            console.log(`%c🎯 TARGET HIT: $${current.toFixed(2)}`, 'color:lime;font-size:16px;font-weight:bold;');

            if (readyToBuy && submitBtn) {
                if (confirmChk) {
                    confirmChk.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    confirmChk.style.outline   = '4px solid lime';
                    confirmChk.style.boxShadow = '0 0 12px lime';
                    setTimeout(() => {
                        confirmChk.style.outline   = '';
                        confirmChk.style.boxShadow = '';
                    }, 5000);
                }
                console.log('%c⚡ AUTO-BUY: Clicking submit. CHECK CONFIRM CHECKBOX NOW!', 'color:red;font-size:14px;font-weight:bold;');
                submitBtn.click();
                stopTracker();
            }
        }

        if (current > warnPrice)    warningFired = false;
        if (current > desiredPrice) targetFired  = false;
    }

    updateUI(current);
    broadcastState(current);
};

// ============================================================
// INIT
// ============================================================
buildUI();

const observer = new MutationObserver(cb);
observer.observe(priceEl, { attributes: true, childList: true, subtree: true });

console.log('%c✅ FreeFall Tracker v6.0', 'color:cyan;font-weight:bold;');
console.log(`%c"${AUCTION_NAME}" | ${sessionRestored ? 'Session restored' : 'New session'} | Set your target in the panel`, 'color:cyan;');
console.log('%cCommands: obsDisconnect() to stop', 'color:#555;');

})();
