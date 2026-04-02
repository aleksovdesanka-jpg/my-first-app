'use strict';
const express = require('express');
const cors    = require('cors');
const https   = require('https');
const http    = require('http');
const cheerio = require('cheerio');
const path    = require('path');
const { URL } = require('url');

const app  = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ── HTTP helper (follows redirects) ─────────────────────────────────────────
function get(rawUrl, { json = false, timeout = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return reject(new Error(`Bad URL: ${rawUrl}`)); }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.get(rawUrl, {
      headers: { 'User-Agent': UA, 'Accept': json ? 'application/json' : 'text/html,*/*' },
    }, res => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        return get(res.headers.location, { json, timeout }).then(resolve, reject);
      }
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (json) { try { resolve(JSON.parse(body)); } catch { resolve(null); } }
        else resolve(body);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ── Parse "Street, City, ST ZIP, Country" → { city, country } ────────────────
function parseAddress(addr) {
  if (!addr) return { city: '', country: '' };
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return { city: parts[0] || '', country: '' };

  const country     = parts[parts.length - 1];
  const beforeCntry = parts[parts.length - 2];
  // If it looks like a state/province code (e.g. "ON", "NY", "CA 90210")
  const isState     = /^[A-Z]{2}(\s+\d{4,5})?$/.test(beforeCntry);
  const city        = isState ? (parts[parts.length - 3] || '') : beforeCntry;

  return { city, country };
}

// ── Fetch ticket link from an event detail page ──────────────────────────────
async function fetchTicketLink(eventUrl) {
  try {
    const html = await get(eventUrl);
    const $    = cheerio.load(html);
    let link   = null;

    $('a[href]').each((_, el) => {
      if (link) return;
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().toLowerCase();

      if (!href.startsWith('http')) return;
      if (href.includes('izprveruke.com'))   return;
      if (href.includes('google.com/cal'))   return;
      if (href.includes('outlook.'))         return;
      if (href.includes('apple.com/cal'))    return;

      if (/ticket|buy|kart|kupe|purchase|tickets/i.test(text)) {
        link = href;
      }
    });

    return link;
  } catch { return null; }
}

// ── Scrape izprveruke.com/events/list/ ───────────────────────────────────────
async function scrapeIzPrveRuke(send) {
  send('status', { message: '🔍 Scraping izprveruke.com for upcoming concerts…' });

  const html = await get('https://izprveruke.com/events/list/');
  const $    = cheerio.load(html);
  const raw  = [];

  $('article[class*="tribe-events"]').each((_, el) => {
    const $el      = $(el);
    const titleEl  = $el.find('.tribe-events-calendar-list__event-title-link');
    const rawTitle = (titleEl.attr('title') || titleEl.text()).trim();
    const eventUrl = titleEl.attr('href');

    if (!rawTitle || !eventUrl) return;

    // "Jelena Rozga – Toronto" → "Jelena Rozga"
    const artist   = rawTitle.split(/\s*[–—\-]+\s*/)[0].trim();
    const dateStr  = $el.find('time[datetime]').first().attr('datetime');
    const timeStr  = $el.find('.tribe-event-date-start').first().text().trim();
    const venue    = $el.find('.tribe-events-calendar-list__event-venue-title').text().trim();
    const address  = $el.find('.tribe-events-calendar-list__event-venue-address').text().trim();
    const { city, country } = parseAddress(address);

    raw.push({ artist, dateStr, timeStr, venue, city, country, address, eventUrl });
  });

  send('status', { message: `📋 Found ${raw.length} events — fetching ticket links in parallel…` });

  // Fetch all ticket links concurrently
  const events = await Promise.all(raw.map(async ev => {
    const ticketLink = await fetchTicketLink(ev.eventUrl).catch(() => null);
    return {
      artist:    ev.artist,
      date:      ev.dateStr || null,
      time:      ev.timeStr || null,
      venue:     ev.venue,
      city:      ev.city,
      country:   ev.country,
      ticketLink,
      eventUrl:  ev.eventUrl,
      source:    'izprveruke.com',
    };
  }));

  return events;
}

// ── Bandsintown: upcoming US/CA events ───────────────────────────────────────
async function fetchBandsintownUSCA(artistName) {
  try {
    const data = await get(
      `https://rest.bandsintown.com/artists/${encodeURIComponent(artistName)}/events?app_id=js_app_id&date=upcoming`,
      { json: true }
    );
    if (!Array.isArray(data)) return [];

    return data
      .filter(e => ['United States', 'Canada'].includes(e.venue?.country))
      .map(e => ({
        artist:    artistName,
        date:      (e.starts_at || e.datetime || '').slice(0, 10) || null,
        time:      null,
        venue:     e.venue?.name || 'TBD',
        city:      [e.venue?.city, e.venue?.region].filter(Boolean).join(', '),
        country:   e.venue?.country || '',
        ticketLink: e.offers?.[0]?.url || null,
        eventUrl:  e.url || null,
        source:    'Bandsintown',
      }));
  } catch { return []; }
}

// ── Dedup key ────────────────────────────────────────────────────────────────
const dedupKey = e =>
  `${e.artist.toLowerCase()}|${(e.date || '').slice(0, 10)}|${e.venue.toLowerCase().replace(/\W/g, '').slice(0, 12)}`;

// ── /api/concerts  (SSE stream) ───────────────────────────────────────────────
app.get('/api/concerts', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const send = (ev, data) => res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // ── Phase 1: izprveruke.com ──────────────────────────────────────────────
    const iprEvents = await scrapeIzPrveRuke(send);
    const seen      = new Set();

    for (const ev of iprEvents) {
      const k = dedupKey(ev);
      if (!seen.has(k)) { seen.add(k); send('concert', ev); }
    }

    send('status', { message: `✅ ${seen.size} concerts from izprveruke.com` });

    // ── Phase 2: Bandsintown cross-reference ─────────────────────────────────
    const artists = [...new Set(iprEvents.map(e => e.artist).filter(Boolean))];
    send('status', { message: `🎵 Cross-referencing ${artists.length} artists on Bandsintown…` });

    let newCount = 0;
    for (let i = 0; i < artists.length; i++) {
      send('status', { message: `🎸 Bandsintown: ${artists[i]} (${i + 1}/${artists.length})…` });
      const events = await fetchBandsintownUSCA(artists[i]);
      for (const ev of events) {
        const k = dedupKey(ev);
        if (!seen.has(k)) { seen.add(k); send('concert', ev); newCount++; }
      }
    }

    const total = seen.size;
    console.log(`  Done: ${total} total (${iprEvents.length} izprveruke, ${newCount} Bandsintown-only)`);
    send('done', { total });
    res.end();

  } catch (err) {
    console.error('Search error:', err.message);
    send('error', { message: err.message });
    res.end();
  }
});

// ── Frontend ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'balkan-concerts.html')));
app.use((req, res) => res.status(404).send('Not found'));

app.listen(PORT, () => {
  console.log(`\n  Balkan Beats — USA & Canada`);
  console.log(`  ────────────────────────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Sources: izprveruke.com + Bandsintown\n`);
});
