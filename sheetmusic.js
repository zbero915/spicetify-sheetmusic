// Sheet Music: a Spicetify extension (single file, no helper, no background process).
// A button in the player bar (next to the lyrics buttons) opens the sheet music of the current song over the main view:
// the score is streamed from Wikimedia Commons into memory, its bars are read from the PDF, and the current bar is highlighted
// following playback using Spotify's tempo/bar analysis or duration estimate. Behind the pages: a moving gradient in the cover's colors.
// Install: put this file in the Spicetify Extensions folder, then
//   spicetify config extensions sheetmusic.js   and   spicetify apply
(async function SheetMusic() {
  "use strict";
  while (!(window.Spicetify && Spicetify.Player && Spicetify.Platform && Spicetify.Playbar && Spicetify.Playbar.Button)) {
    await new Promise((r) => setTimeout(r, 300));
  }

// ---- bar detection ----------------------------------------------------------
// Finds staff lines (long horizontal dark runs), groups 5 lines into staves,
// joins staves into systems via the left system line, then finds barlines as
// columns that are dark across the full height of every staff in the system.
function smAnalyze(cv) {
  const W = cv.width, H = cv.height;
  const px = cv.getContext("2d").getImageData(0, 0, W, H).data;
  const dk = (x, y) => px[(y * W + x) * 4] < 170;

  const rows = [];
  for (let y = 0; y < H; y++) {
    let run = 0, best = 0, bx = 0;
    for (let x = 0; x < W; x++) {
      if (dk(x, y)) {
        run++;
        if (run > best) { best = run; bx = x - run + 1; }
      } else run = 0;
    }
    if (best > W * 0.25) rows.push({ y, x0: bx, x1: bx + best });
  }
  const lines = [];
  rows.forEach((r) => {
    const l = lines[lines.length - 1];
    if (l && r.y - l.yEnd <= 1) { l.yEnd = r.y; l.x0 = Math.min(l.x0, r.x0); l.x1 = Math.max(l.x1, r.x1); }
    else lines.push({ yS: r.y, yEnd: r.y, x0: r.x0, x1: r.x1 });
  });
  lines.forEach((l) => (l.y = (l.yS + l.yEnd) / 2));

  const staves = [];
  for (let i = 0; i + 4 < lines.length; ) {
    const s = lines[i + 1].y - lines[i].y;
    let ok = s > 2;
    for (let k = 1; k < 5 && ok; k++) ok = Math.abs(lines[i + k].y - lines[i + k - 1].y - s) < s * 0.35;
    if (ok) {
      const g = lines.slice(i, i + 5);
      staves.push({
        top: g[0].y, bot: g[4].y, s: (g[4].y - g[0].y) / 4,
        x0: Math.min(...g.map((l) => l.x0)), x1: Math.max(...g.map((l) => l.x1)),
      });
      i += 5;
    } else i++;
  }

  const joined = (a, b) => {
    const y0 = Math.round(a.bot) + 2, y1 = Math.round(b.top) - 2;
    if (y1 - y0 < 3) return true;
    const x0 = Math.round(Math.min(a.x0, b.x0));
    for (let x = x0 - 3; x <= x0 + 3; x++) {
      if (x < 0 || x >= W) continue;
      let n = 0;
      for (let y = y0; y <= y1; y++) if (dk(x, y)) n++;
      if (n >= (y1 - y0 + 1) * 0.9) return true;
    }
    return false;
  };
  const systems = [];
  staves.forEach((st, k) => {
    if (k && joined(staves[k - 1], st)) systems[systems.length - 1].push(st);
    else systems.push([st]);
  });

  const bars = [];
  systems.forEach((sys) => {
    const top = sys[0].top, bot = sys[sys.length - 1].bot, s = sys[0].s;
    const x0 = Math.min(...sys.map((t) => t.x0)), x1 = Math.min(W - 1, Math.max(...sys.map((t) => t.x1)));
    const clusters = [];
    for (let x = Math.round(x0 + 4 * s); x <= x1; x++) {
      const full = sys.every((t) => {
        const a = Math.round(t.top) - 1, b = Math.round(t.bot) + 1;
        let n = 0;
        for (let y = a; y <= b; y++) if (dk(x, y)) n++;
        return n >= (b - a + 1) * 0.93;
      });
      if (!full) continue;
      const c = clusters[clusters.length - 1];
      if (c && x - c.e <= 3) c.e = x;
      else clusters.push({ b: x, e: x });
    }
    const ends = [];
    clusters.forEach((c) => {
      const x = (c.b + c.e) / 2, thick = c.e - c.b + 1 >= 0.3 * s;
      if (x < x0 + 6 * s) return;
      const last = ends[ends.length - 1];
      if (last && x - last.x < 3 * s) { last.x = x; last.thick = last.thick || thick; } // double barline
      else ends.push({ x, thick });
    });
    if (!ends.length || x1 - ends[ends.length - 1].x > 3 * s) ends.push({ x: x1, thick: false });
    // The first bar of a line begins after the clef, key signature and time signature, not at the left edge: the
    // cursor must start on the first note. Walk right from the line's left edge through the connected ink of that header
    // (clef, sharps/flats, time signature: gaps under 1.8 staff spaces) and take the next ink as the first note.
    const inkAt = (x, mg = 0.8) => sys.some((t) => {
      const a = Math.round(t.top - mg * s), b = Math.round(t.bot + mg * s);
      let n = 0;
      for (let y = a; y <= b; y++) {
        const k = (y - t.top) / t.s, kr = Math.round(k);
        if (kr >= 0 && kr <= 4 && Math.abs(k - kr) * t.s <= 1.5) continue; // staff line pixels are not ink
        if (x >= 0 && x < W && y >= 0 && y < H && dk(x, y)) n++;
      }
      return n >= 2;
    });
    let start = x0 + 6 * s, lastInk = -1, firstNote = null;
    for (let x = Math.round(x0); x <= Math.min(x1, Math.round(x0 + 30 * s)); x++) {
      if (!inkAt(x)) continue;
      if (lastInk < 0 || x - lastInk <= 1.8 * s) lastInk = x;
      else { firstNote = x; break; }
    }
    if (firstNote !== null && ends.length && firstNote < ends[0].x - 2 * s) {
      start = Math.max(x0 + 4 * s, lastInk > 0 ? (lastInk + firstNote) / 2 : firstNote - 1.5 * s);
    }
    // where the first note of a bar sits (just after its opening barline): the cursor runs from first note to first note
    const isBarCol = (x) => sys.every((t) => {
      const a = Math.round(t.top) - 1, b = Math.round(t.bot) + 1;
      let n = 0;
      for (let y = a; y <= b; y++) if (x >= 0 && x < W && y >= 0 && y < H && dk(x, y)) n++;
      return n >= (b - a + 1) * 0.93;
    });
    const noteAfter = (bx, lim) => {
      let x = Math.ceil(bx + 0.3 * s);
      while (x < lim && isBarCol(x)) x++; // skip the barline itself (thin, thick or double)
      for (; x < lim - 1.5 * s; x++) if (inkAt(x, 0.3)) return x + 0.4 * s;
      return null;
    };
    let first = true;
    ends.forEach((e) => {
      if (e.x - start > 2 * s) {
        const n0 = first ? (firstNote !== null ? firstNote + 0.4 * s : noteAfter(start, e.x)) : noteAfter(start, e.x);
        bars.push({ x0: start / W, n0: (n0 !== null && n0 < e.x - 1.5 * s ? n0 : start) / W, x1: e.x / W, y: (top + bot) / 2 / H, h: (bot - top) / H, fin: e.thick });
      }
      first = false;
      start = e.x;
    });
  });
  return bars;
}


// ---- reading a Spotify title ----
// Composers (spellings as they appear in titles and artist names, accents removed). Used to tell the composer apart from
// the performer, which is what the search has to be built from.
const SM_COMPOSERS = {
  Beethoven: ["beethoven"], Mozart: ["mozart"], Chopin: ["chopin"], Bach: ["bach"], Debussy: ["debussy"], Satie: ["satie"],
  Liszt: ["liszt"], Schubert: ["schubert"], Schumann: ["schumann"], Brahms: ["brahms"],
  Tchaikovsky: ["tchaikovsky", "tchaikowsky", "tchaikovski", "chaikovsky", "tschaikowsky"],
  Rachmaninoff: ["rachmaninoff", "rachmaninov", "rachmaninow"], Haydn: ["haydn"], Handel: ["handel", "haendel"], Vivaldi: ["vivaldi"],
  Mendelssohn: ["mendelssohn"], Grieg: ["grieg"], Ravel: ["ravel"], Scriabin: ["scriabin", "skryabin", "scriabine"],
  Prokofiev: ["prokofiev", "prokofieff"], Shostakovich: ["shostakovich", "schostakowitsch"], Dvorak: ["dvorak"], Paganini: ["paganini"],
  Pachelbel: ["pachelbel"], Albeniz: ["albeniz"], Granados: ["granados"], Faure: ["faure"], "Saint-Saens": ["saint saens"],
  Bizet: ["bizet"], Verdi: ["verdi"], Puccini: ["puccini"], Wagner: ["wagner"], Mahler: ["mahler"], Sibelius: ["sibelius"],
  "Rimsky-Korsakov": ["rimsky korsakov", "rimsky"], Mussorgsky: ["mussorgsky", "moussorgsky", "mussorgski"], Borodin: ["borodin"],
  Stravinsky: ["stravinsky"], Bartok: ["bartok"], Smetana: ["smetana"], Clementi: ["clementi"], Czerny: ["czerny"],
  Scarlatti: ["scarlatti"], Couperin: ["couperin"], Rameau: ["rameau"], Weber: ["weber"], Rossini: ["rossini"], Bellini: ["bellini"],
  Donizetti: ["donizetti"], Gounod: ["gounod"], Massenet: ["massenet"], Franck: ["franck"], Poulenc: ["poulenc"], Glinka: ["glinka"],
  Khachaturian: ["khachaturian"], Kreisler: ["kreisler"], Sarasate: ["sarasate"], Bruch: ["bruch"], Telemann: ["telemann"],
  Purcell: ["purcell"], Corelli: ["corelli"], Albinoni: ["albinoni"], Boccherini: ["boccherini"], Tarrega: ["tarrega"],
  Joplin: ["joplin"], Gershwin: ["gershwin"], Elgar: ["elgar"], Holst: ["holst"], Offenbach: ["offenbach"], Strauss: ["strauss"],
  Chaminade: ["chaminade"], Moszkowski: ["moszkowski"], Field: ["john field"], Berlioz: ["berlioz"], Gluck: ["gluck"],
};
const smHasComp = (text, name) => { const n = " " + smNorm(text) + " "; return (SM_COMPOSERS[name] || []).some((f) => n.includes(" " + f + " ")); };
const smComposerIn = (text) => Object.keys(SM_COMPOSERS).find((c) => smHasComp(text, c)) || null;

const SM_STOP = new Set(["the", "and", "for", "von", "van", "der", "de", "in", "op", "opus", "no", "nr", "number", "major", "minor", "sharp", "flat",
  "dur", "moll", "sonata", "piano", "score", "pdf", "solo", "pour", "du", "des", "la", "le", "of", "an"]);
const SM_TEMPO = new Set(["allegro", "adagio", "andante", "presto", "largo", "moderato", "vivace", "scherzo", "rondo", "finale", "minuet", "menuetto",
  "allegretto", "lento", "grave", "prestissimo", "sostenuto", "maestoso", "cantabile", "con", "brio", "moto", "spirito", "assai", "molto", "non",
  "troppo", "tempo", "giusto", "poco", "ma", "un", "di", "la", "il", "e", "trio", "tema", "theme", "variation", "variations", "intro", "introduction"]);
const SM_TYPE_LIST = ["sonata", "sonatina", "nocturne", "prelude", "etude", "waltz", "mazurka", "polonaise", "ballade", "scherzo", "impromptu", "fantasia", "fantaisie", "rhapsody", "concerto", "symphony", "suite", "variations", "fugue", "invention", "partita", "gymnopedie", "arabesque", "barcarolle", "berceuse", "bagatelle", "romance", "serenade", "minuet", "canon", "capriccio", "toccata", "intermezzo", "rondo", "march", "gavotte", "gigue", "sarabande", "liebestraum", "lied", "trio", "quartet", "quintet"];
const SM_TYPES = new RegExp("\\b(" + SM_TYPE_LIST.join("|") + ")");
const SM_CATW = new Set(["bwv", "woo", "rv", "kv", "hob", "hwv", "op", "grandes"]);
// words that name a kind of piece (or a catalogue) rather than the piece: "Nocturne", "Sonata" (also in plural / foreign endings)
const smGeneric = (w) => SM_CATW.has(w) || SM_TYPE_LIST.some((t) => w === t || (w.length >= 5 && t.length >= 5 && Math.abs(w.length - t.length) <= 3 && w.startsWith(t.slice(0, Math.max(5, t.length - 2)))));
const SM_CATALOG = /\b(?:Op\.?|BWV|KV|K\.|D\.|S\.|L\.|WoO|Hob\.?|RV|HWV)\s*\d+[a-z]?(?:\s*(?:No\.?|Nr\.?)\s*\d+)?/i;
const SM_KEY = /\b[Ii]n\s+[A-Ga-g](?:[\s-]*(?:sharp|flat|natural|#|\u266f|\u266d))?[\s-]*(?:major|minor|dur|moll)\b/gi;

// stays lower-case letters and digits; "BWV846" -> "bwv 846", "Op.27" -> "op 27"
const smNorm = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2").replace(/[^a-z0-9]+/g, " ").trim();
function smTokens(q) {
  let t = [...new Set(smNorm(q).split(" ").filter((w) => (w.length > 1 || /^\d$/.test(w)) && !SM_STOP.has(w)))];
  if (t.some((w) => /^\d{2,}$/.test(w))) t = t.filter((w) => !/^\d$/.test(w)); // "No. 2" next to "Op. 27" says little
  return t;
}
// share of the tokens found in a text; words match their plural / foreign endings (sonata ~ sonate, nocturne ~ nocturnes)
function smRel(title, toks) {
  if (!toks.length) return 0;
  const words = smNorm(title).split(" ");
  const has = (t) => /^\d+$/.test(t) ? words.includes(t)
    : words.some((w) => w === t || (t.length >= 5 && Math.abs(w.length - t.length) <= 3 && w.startsWith(t.slice(0, Math.max(5, t.length - 2)))));
  return toks.filter(has).length / toks.length;
}

// the song name as searched: bracketed parts removed, movement after ":" dropped
const smClean = (s) => s.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
const smWorkClean = (s) => s
  .replace(/\b\d+\s*(?:st|nd|rd|th)?\s*(?:mov(?:ement|t)?|mvt)\b\.?/gi, " ")   // "1st Movement", "2nd mvt"
  .replace(/\b(?:mov(?:ement|t)?|mvt)\.?\s*(?:\d+|[IVX]+)\b/gi, " ")            // "Movement 1", "Mvt. II"
  .replace(/\b(?:remaster(?:ed)?|live|version|mono|stereo)\b.*$/i, " ")
  .replace(/["\u201c\u201d]/g, " ").replace(/\s+/g, " ").trim();

// Splits "Chopin: Nocturne in E-Flat Major, Op. 9 No. 2 "Name": I. Adagio" and "Beethoven - Fur Elise" into composer, work,
// nickname and movement. The composer comes from the title, else from the artists (never the performer: only known composers count).
function smParse(title, artists) {
  const t = smClean(title || "");
  const parts = t.split(":").map((s) => s.trim()).filter(Boolean);
  let comp = null;
  if (parts.length > 1 && smNorm(parts[0]).split(" ").length <= 3) { const c = smComposerIn(parts[0]); if (c) { comp = c; parts.shift(); } }
  let raw = parts[0] || "";
  const mvt = parts.slice(1).join(": ");
  const dash = raw.split(/\s[-\u2013\u2014]\s/);
  if (dash.length > 1 && smNorm(dash[0]).split(" ").length <= 3) { const c = smComposerIn(dash[0]); if (c) { comp = comp || c; raw = dash.slice(1).join(" - "); } }
  else raw = dash[0];
  const nick = ((raw.match(/["\u201c](.+?)["\u201d]/) || t.match(/["\u201c](.+?)["\u201d]/) || [])[1] || "").trim();
  const noNick = raw.replace(/["\u201c].+?["\u201d]/g, " ");
  const base = smWorkClean(noNick);
  const people = (artists || []).filter((a) => !/orchestra|ensemble|quartet|quintet|collegium|philharm|symphon|choir|chamber|trio|band|consort|academy|festival|players|soloists|camerata|orkest|kapelle/i.test(a));
  comp = comp || smComposerIn(people.join(" ")) || smComposerIn(base) || null;
  const core = base.replace(SM_KEY, " ").replace(/\bfor\s+(?:solo\s+)?(?:piano|violin|cello|guitar|organ|orchestra)\b.*$/i, " ").replace(/[,;]/g, " ").replace(/\s+/g, " ").trim();
  const mvtName = mvt.replace(/^\s*(?:[IVX]+|\d+)\s*[.)]\s*/, "").replace(/\b(?:remaster(?:ed)?|live)\b.*$/i, "").trim();
  const mvtWords = smNorm(mvtName).split(" ").filter(Boolean);
  const mvtKey = mvtWords.length && mvtWords.some((w) => w.length > 2 && !SM_TEMPO.has(w)) ? mvtName : "";
  const toks = smTokens(core);
  return { title: t, comp, core, base, nick, mvt, mvtName: mvtKey, toks, words: toks.filter((w) => !/^\d+$/.test(w)), nickToks: nick ? smTokens(nick) : [] };
}
const smBase = (s) => smParse(s, []).base;

// does a sheet (its file name + description) belong to the parsed song?
// - another composer's name in it: no. The song's nickname in it: yes.
// - if the composer is not named in the sheet, every word and number of the title must be there.
// - titles with a distinctive name (Fur Elise, Clair de lune) match on that name; titles that are only a kind of piece and a
//   number (Nocturne Op. 9 No. 2, Prelude BWV 846) must also carry the number.
function smAccept(text, P) {
  const hasC = !!P.comp && smHasComp(text, P.comp);
  if (P.comp && !hasC && smComposerIn(text)) return false;
  if (P.nickToks.length && smRel(text, P.nickToks) === 1) return true;
  if (!P.toks.length) return false;
  const rel = smRel(text, P.toks);
  if (P.comp && !hasC && rel < 1) return false;
  const ident = P.words.filter((w) => !smGeneric(w));
  if (ident.length) return smRel(text, ident) >= 0.75;
  const nums = P.toks.filter((w) => /^\d+$/.test(w));
  if (!nums.length) return rel >= 0.6 && (!!P.comp || rel === 1);
  return smRel(text, nums) >= 0.5 && rel >= 0.6 && (!!P.comp || rel === 1);
}

// "I. Adagio", "2nd movement" -> 0-based movement index, else null
function smMovement(title) {
  const roman = { I: 0, II: 1, III: 2, IV: 3, V: 4, VI: 5, VII: 6, VIII: 7, IX: 8, X: 9 };
  const after = smParse(title, []).mvt;
  let m = after.match(/^\s*(X|IX|VIII|VII|VI|V|IV|III|II|I)\./);
  if (m) return roman[m[1]];
  m = after.match(/^\s*(\d)\./) || title.match(/\b(\d)(?:st|nd|rd|th)\s+mov/i) || title.match(/\bmov(?:ement|t)?\.?\s*(\d)/i);
  return m ? parseInt(m[1], 10) - 1 : null;
}

// searches to try for a parsed title, best first (Commons needs every word of a query, so there are short ones and exact ones)
const SM_SPELL = [[/czardas/i, "Csárdás"], [/moonlight/i, "Piano Sonata No. 14 Op. 27"], [/for elise|fur elise|für elise/i, "Für Elise"], [/pathetique|pathétique/i, "Piano Sonata No. 8 Op. 13"], [/canon in d/i, "Canon in D Pachelbel"], [/clair de lune/i, "Clair de lune"], [/gymnop/i, "Gymnopédie"], [/liebestr/i, "Liebesträume"]];
function smQueries(P) {
  const { comp, nick, core, mvtName } = P;
  const type = (smNorm(core).match(SM_TYPES) || [])[1];
  const op = (core.match(SM_CATALOG) || [])[0];
  const num = (core.match(/\bN(?:o|r|umber)\.?\s*(\d+)/i) || [])[1];
  const alt = (SM_SPELL.find(([re]) => re.test(core + " " + nick)) || [])[1];
  const q = [];
  const add = (...p) => { const s = p.filter(Boolean).join(" ").replace(/\s+/g, " ").trim(); if (s.length > 2) q.push(s); };
  if (nick) { add(nick, comp); add(nick); }
  add(comp, core);
  if (type && num) add(comp, type, num);
  if (type && op) add(comp, type, op);
  add(core);
  if (alt && alt !== core) { add(comp, alt); add(alt); }
  if (mvtName) { add(comp, mvtName); add(mvtName); }
  return [...new Map(q.map((s) => [s.toLowerCase(), s])).values()];
}


// ---- automatic sync ----
// Spotify's own analysis of the recording gives its bar start times (ms). Score bars are laid onto that grid:
// score bar i sits at fraction i/N of the score, which is the same fraction of the recording's bars, so a
// different bar count (Spotify often counts half or double) still lines up, and tempo changes and silence at
// the start or end are followed. The grid is blended 50/50 with even spacing because it can miss or double bars.
// Returns N+1 anchors {t (ms), i}; the last one is the end of the music.
// Bar duration weights when no beat data exists. First bar slightly heavier (settling into
// tempo), penultimate heavier (ritardando), final bar 2× (held chord / fermata).
// Normalized so the total stays at N + 1 — the same baseline as the original even-spacing
// model — to prevent the edge bumps from compressing the middle bars.
function smBarWeights(N) {
  if (N < 4) return new Array(N).fill(1);
  const w = [];
  for (let i = 0; i < N; i++) {
    if (i === N - 1) w.push(2.0);
    else if (N >= 8 && i === N - 2) w.push(1.35);
    else if (N >= 8 && i === N - 3) w.push(1.15);
    else if (N >= 8 && i === 0) w.push(1.20);
    else if (N >= 8 && i === 1) w.push(1.08);
    else w.push(1.0);
  }
  if (N >= 8) {
    const target = N + 1, sum = w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < N; i++) w[i] *= target / sum;
  }
  return w;
}

function smAnchors(N, grid, dur, span, meta) {
  // Spotify's bar count only helps when it is about the same as the score's (1x), half or double of it; any other
  // ratio means its analysis read the music differently (other tempo / time signature), so it is ignored.
  const r = grid && N ? grid.length / N : 0;
  const same = r >= 0.8 && r <= 1.25;
  const good = !!grid && grid.length >= 4 && (same || (r >= 1.7 && r <= 2.35) || (r >= 0.42 && r <= 0.6));
  const wGrid = same ? 0.75 : 0.5;
  // span = {s, e}: where the recording is audible (first and last sound above silence, from Spotify's loudness analysis).
  // Without it the music is assumed to start after lead-in silence and to end a few seconds before the track does.
  const hasSpan = !!span && span.e - span.s > 5000 && span.s >= 0;
  let t0 = hasSpan ? span.s : Math.min(2200, Math.max(800, Math.round((dur / (N + 1)) * 0.35))), t1 = dur;
  if (good) {
    const last = grid[grid.length - 1], step = last - grid[grid.length - 2];
    t0 = Math.max(0, grid[0]);
    t1 = Math.min(dur, last + step);
    if (hasSpan) t1 = Math.min(t1, Math.max(span.e, last + step * 0.5)); // no running on into the silence after the last chord
  } else if (hasSpan) t1 = Math.min(dur, span.e);
  // Without Spotify's bar data and loudness: the music stops before the track does (final chord dying away, silence), and the
  // opening and closing bars slow down (deliberate start, ritardando into the final held chord).
  if (!good && !hasSpan) t1 = Math.max(t0 + 1000, dur - Math.min(4500, Math.max(2500, Math.round(dur * 0.008))));
  const w = smBarWeights(N);
  const cum = [0];
  for (let k = 0; k < N; k++) cum.push(cum[cum.length - 1] + w[k]);
  const wsum = cum[cum.length - 1];
  // no usable bar grid: every bar lasts (60/bpm)*beats, counted from the first sound
  if (!good) { const spb = smPace(N, t1 - t0, meta, wsum); if (spb) t1 = Math.min(dur, t0 + spb * wsum); }
  const out = [];
  for (let i = 0; i <= N; i++) {
    let t = t0 + ((t1 - t0) * cum[i]) / wsum;
    if (good) {
      const u = (i * grid.length) / N; // position in recording bars
      const k = Math.min(Math.floor(u), grid.length - 1);
      const next = k + 1 < grid.length ? grid[k + 1] : t1;
      t = wGrid * (grid[k] + (next - grid[k]) * (u - k)) + (1 - wGrid) * t;
    }
    out.push({ t, i });
  }
  return out;
}

// Seconds per bar = (60 / bpm) * beats per bar. Tempo comes from the score's own marking (if the PDF has text) and Spotify's
// analysis; beats per bar from the printed time signature and Spotify. Tempo may be read at half/double speed and the time
// signature is a guess, so every combination is tried and the one whose bar count fits the audible length of the recording
// best wins. null when nothing fits (repeats, wrong data): the old even spacing is used then.
function smPace(N, avail, meta, wsum) {
  if (!meta || !N || !(avail > 5000)) return null;
  const bpms = [meta.bpm, meta.tempo].filter((v) => v >= 30 && v <= 300);
  const beats = [...new Set([...(meta.beats || []), 4, 3, 2, 6])].filter((v) => v > 0);
  const totalBars = wsum || (N >= 8 ? N + 1 : N);
  let best = null;
  bpms.forEach((bp, bi) => [1, 2, 0.5].forEach((m, mi) => beats.forEach((b, ki) => {
    const spb = (60000 / (bp * m)) * b;
    const err = Math.abs(Math.log((spb * totalBars) / avail)) + bi * 0.02 + mi * 0.03 + ki * 0.004;
    if (!best || err < best.err) best = { spb, err };
  })));
  return best && best.err < 0.2 ? best.spb : null;
}

// Hand calibration: cal = [{b, t}] says "at time t (ms) the music was at bar position b (bar index + fraction)".
// One point sets the speed (the music is assumed to start at the default start); two or more are joined piece by piece.
// Start and end stay pinned; a hand point in the middle adjusts the middle while preserving the base timing curve.
function smCalibrate(N, base, cal) {
  const pts = [...(cal || [])].filter((c) => c && isFinite(c.b) && isFinite(c.t) && c.b > 0 && c.b < N + 1).sort((a, b) => a.b - b.b);
  if (!pts.length || !base || !base.length) return base;
  const ctl = [{ b: 0, t: base[0].t }];
  pts.forEach((p) => { if (p.t > ctl[ctl.length - 1].t && p.b > ctl[ctl.length - 1].b + 1e-6) ctl.push(p); });
  if (ctl.length < 2) return base;
  if (ctl[ctl.length - 1].b < N) {
    ctl.push({ b: N, t: base[N].t });
  }
  const tAt = (b) => {
    const k = Math.max(0, Math.min(N - 1, Math.floor(b))), f = b - k;
    return base[k].t + f * (base[k + 1].t - base[k].t);
  };
  const out = [];
  for (let i = 0; i <= N; i++) {
    let k = 1;
    while (k < ctl.length - 1 && ctl[k].b < i) k++;
    const a = ctl[k - 1], c = ctl[k];
    const tA = tAt(a.b), tC = tAt(c.b), span = tC - tA || 1;
    const frac = (base[i].t - tA) / span;
    out.push({ i, t: a.t + (c.t - a.t) * Math.max(0, Math.min(1, frac)) });
  }
  return out;
}

// Beat times of this exact recording: Spotify track -> ISRC -> MusicBrainz recording -> AcousticBrainz rhythm data (frozen since 2022,
// so only older recordings are in it). Used only when the recording's length matches Spotify's within 1.5 s, else it is another master.
async function smBeats(track) {
  const key = "sm:ab1:" + track.uri;
  try { const c = JSON.parse(localStorage.getItem(key)); if (c && (c.none ? Date.now() - c.none < 6048e5 : c.beats)) return c.beats ? c : null; } catch (e) {}
  const get = async (url) => { const r = await fetch(url, { signal: AbortSignal.timeout(6000) }); if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); };
  try {
    const id = track.uri.split(":").pop();
    let isrc = null;
    try { const t = await Spicetify.CosmosAsync.get("https://api.spotify.com/v1/tracks/" + id); isrc = t && t.external_ids && t.external_ids.isrc; } catch (e) {}
    if (!isrc) throw new Error("no isrc");
    const mb = await get("https://musicbrainz.org/ws/2/isrc/" + isrc + "?fmt=json");
    const recs = ((mb && mb.recordings) || []).slice(0, 4);
    for (const r of recs) {
      try {
        const ab = await get("https://acousticbrainz.org/api/v1/" + r.id + "/low-level");
        const len = ab && ab.metadata && ab.metadata.audio_properties && ab.metadata.audio_properties.length;
        const beats = ab && ab.rhythm && ab.rhythm.beats_position;
        if (!beats || beats.length < 8 || !len || Math.abs(len * 1000 - track.dur) > 1500) continue;
        const out = { beats: beats.map((b) => Math.round(b * 1000)), bpm: ab.rhythm.bpm > 0 ? ab.rhythm.bpm : null };
        try { localStorage.setItem(key, JSON.stringify(out)); } catch (e) {}
        return out;
      } catch (e) {}
    }
  } catch (e) {}
  try { localStorage.setItem(key, JSON.stringify({ none: Date.now() })); } catch (e) {}
  return null;
}
// bar start times from beat times: beats per bar chosen so that the bar count matches the score's
function smBarsFromBeats(beats, N, meta) {
  if (!beats || beats.length < 8 || !N) return null;
  const cand = [...new Set([...((meta && meta.beats) || []).map(Math.round).filter((v) => v >= 2 && v <= 12), 4, 3, 2, 6, 8, 12])];
  let best = null;
  cand.forEach((b, i) => { const err = Math.abs(Math.log(beats.length / b / N)) + i * 0.01; if (!best || err < best.err) best = { b, err }; });
  if (!best || best.err > 0.2) return null;
  const g = [];
  for (let k = 0; k * best.b < beats.length; k++) g.push(beats[k * best.b]);
  return g.length >= 4 ? g : null;
}

async function smGrid(uri) {
  const key = "sm:grid2:" + uri;
  try { const c = JSON.parse(localStorage.getItem(key)); if (c && c.g) return c; } catch (e) {}
  try {
    const id = uri.split(":").pop();
    const ask = async () => {
      try { if (Spicetify.getAudioData) { const r = await Spicetify.getAudioData(uri); if (r && r.bars && r.bars.length) return r; } } catch (e) {}
      try { const r = await Spicetify.CosmosAsync.get("https://spclient.wg.spotify.com/audio-attributes/v1/audio-analysis/" + id + "?format=json"); if (r && r.bars && r.bars.length) return r; } catch (e) {}
      return Spicetify.CosmosAsync.get("https://api.spotify.com/v1/audio-analysis/" + id);
    };
    const d = await Promise.race([ask(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000))]);
    const g = ((d && d.bars) || []).map((b) => Math.round(b.start * 1000));
    // first and last moment with real sound (segments quieter than -45 dB are silence)
    let s = null, e = null;
    ((d && d.segments) || []).forEach((x) => { if (x.loudness_max > -45) { if (s === null) s = x.start; e = x.start + x.duration; } });
    const tr = (d && d.track) || {};
    const out = { g: g.length >= 4 ? g : [], s: s !== null ? Math.round(s * 1000) : null, e: e !== null ? Math.round(e * 1000) : null,
      tempo: tr.tempo > 0 ? tr.tempo : null, ts: tr.time_signature >= 2 ? tr.time_signature : null };
    if (out.g.length || out.tempo || (out.s !== null && out.e - out.s > 5000)) { try { localStorage.setItem(key, JSON.stringify(out)); } catch (er) {} return out; }
  } catch (e) {}
  return null;
}

  // ======================= extension body =======================
  const PDFJS_HOSTS = [
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/",
    "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/",
  ];
  let pdfJsP = null;
  function smLoadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfJsP) return pdfJsP;
    const tryHost = (base, file) => new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = base + file;
      s.onload = () => resolve();
      s.onerror = () => { s.remove(); reject(new Error("load " + base)); };
      document.head.appendChild(s);
    });
    pdfJsP = (async () => {
      let base = null;
      for (const h of PDFJS_HOSTS) {
        try { await tryHost(h, h.includes("jsdelivr") ? "pdf.min.js" : "pdf.min.js"); base = h; break; } catch (e) {}
      }
      if (!base || !window.pdfjsLib) { pdfJsP = null; throw new Error("pdf.js could not be loaded"); }
      let worker = base + "pdf.worker.min.js";
      try { // a blob worker works even when the CDN origin is not allowed to host workers
        const code = await (await fetch(worker)).text();
        worker = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
      } catch (e) {}
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = worker;
      return window.pdfjsLib;
    })();
    return pdfJsP;
  }

  const CSS = `
@property --sm-c1{syntax:'<color>';inherits:true;initial-value:#3b2f63}
@property --sm-c2{syntax:'<color>';inherits:true;initial-value:#1f4d5c}
.sm-ov{position:fixed;z-index:99;overflow:hidden;border-radius:8px;background:#0b0b10;color:#fff;display:flex;flex-direction:column;
  --sm-c1:#3b2f63;--sm-c2:#1f4d5c;--sm-cur:#1db954;transition:--sm-c1 1.6s,--sm-c2 1.6s}
.sm-ov[hidden],.sm-ov [hidden]{display:none!important}
.sm-bg{position:absolute;inset:0;overflow:hidden}
.sm-bg i{position:absolute;width:75vmax;height:75vmax;border-radius:50%;filter:blur(70px) saturate(1.35);opacity:.85;will-change:transform}
.sm-b1{background:radial-gradient(circle,var(--sm-c1) 0,transparent 66%);top:-30%;left:-25%;animation:sm-a 26s ease-in-out infinite alternate}
.sm-b2{background:radial-gradient(circle,var(--sm-c2) 0,transparent 66%);right:-30%;bottom:-35%;animation:sm-b 32s ease-in-out infinite alternate}
.sm-b3{background:radial-gradient(circle,var(--sm-c1) 0,var(--sm-c2) 38%,transparent 68%);top:15%;left:20%;opacity:.55;animation:sm-c 40s ease-in-out infinite alternate}
@keyframes sm-a{to{transform:translate(22%,16%) rotate(40deg) scale(1.2)}}
@keyframes sm-b{to{transform:translate(-20%,-14%) rotate(-35deg) scale(1.15)}}
@keyframes sm-c{from{transform:translate(-12%,8%) scale(.9)}to{transform:translate(14%,-10%) rotate(60deg) scale(1.15)}}
.sm-shade{position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.22),rgba(0,0,0,.5))}
.sm-head{position:relative;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:22px 28px 10px}
.sm-title{font-size:26px;font-weight:800;line-height:1.15;text-shadow:0 2px 12px rgba(0,0,0,.35)}
.sm-sub{font-size:14px;opacity:.8;margin-top:4px}
.sm-status{font-size:12px;opacity:.65;margin-top:6px;min-height:15px}
.sm-actions{display:flex;gap:6px;flex-shrink:0}
.sm-icon{width:38px;height:38px;display:grid;place-items:center;border:0;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;cursor:pointer;backdrop-filter:blur(8px)}
.sm-icon:hover:not(:disabled){background:rgba(255,255,255,.24)}
.sm-icon:disabled{opacity:.35;cursor:default}
.sm-icon svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.sm-scroll{position:relative;flex:1;overflow-y:auto;padding:8px 24px 45vh;scrollbar-width:thin}
.sm-pages{display:flex;flex-direction:column;align-items:center;gap:18px}
.sm-page{position:relative;width:min(100%,860px);aspect-ratio:1/1.414;background:#fff;border-radius:3px;box-shadow:0 10px 40px rgba(0,0,0,.45)}
.sm-page canvas{position:absolute;inset:0;width:100%;height:100%}
.sm-hl{position:absolute;background:var(--sm-cur);opacity:.18;border-radius:4px;box-shadow:inset 0 0 0 1.5px var(--sm-cur);pointer-events:none;z-index:1;transition:left .1s ease-out,width .1s ease-out,top .1s ease-out}
.sm-icon.on{background:rgba(255,255,255,.35)}
.sm-night .sm-page{background:#17171d;box-shadow:0 10px 40px rgba(0,0,0,.7)}
.sm-night .sm-page canvas{filter:invert(.9) hue-rotate(180deg)}
.sm-night .sm-hl{--sm-cur:var(--sm-curn,#5ef28d);opacity:.25}
.sm-msg{position:absolute;inset:0;display:grid;place-items:center;text-align:center;font-size:18px;opacity:.75;padding:0 40px;pointer-events:none}
`;
  const ICON_BTN = '<svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6 2v7.3A2.5 2.5 0 1 0 7.5 11.5V4.8L12 3.9v4.4a2.5 2.5 0 1 0 1.5 2.3V1.5L6 2z"/></svg>';
  const ICON_DL = '<svg viewBox="0 0 24 24"><path d="M12 3v11M7.5 10 12 14.5 16.5 10M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>';
  const ICON_SYNC = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/></svg>';
  const ICON_MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/></svg>';
  const ICON_NEXT = '<svg viewBox="0 0 24 24"><path d="M20 11A8 8 0 0 0 5.6 6.2L4 8M4 4v4h4M4 13a8 8 0 0 0 14.4 4.8L20 16M20 20v-4h-4"/></svg>';

  const readJSON = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } };
  const writeJSON = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

  // ---- colors: primary and secondary of the cover art ----
  const hex2rgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ""); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const rgb2hex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
  const cdist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  function rgb2hsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    if (!d) return [0, 0, l];
    const s = d / (1 - Math.abs(2 * l - 1));
    const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, s, l];
  }
  function hsl2rgb([h, s, l]) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
  }
  async function colorsFromImage(url) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("cover")); img.src = url; });
    const cv = document.createElement("canvas");
    cv.width = cv.height = 32;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0, 32, 32);
    const px = ctx.getImageData(0, 0, 32, 32).data, bins = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const k = (px[i] >> 5) * 64 + (px[i + 1] >> 5) * 8 + (px[i + 2] >> 5);
      const e = bins.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += px[i]; e.g += px[i + 1]; e.b += px[i + 2];
      bins.set(k, e);
    }
    const list = [...bins.values()].map((e) => ({ rgb: [e.r / e.n, e.g / e.n, e.b / e.n], w: e.n * (0.4 + rgb2hsl([e.r / e.n, e.g / e.n, e.b / e.n])[1]) })).sort((a, b) => b.w - a.w);
    const first = list[0].rgb, second = (list.find((x) => cdist(x.rgb, first) > 90) || list[1] || list[0]).rgb;
    return [rgb2hex(first), rgb2hex(second)];
  }
  async function trackColors(t) {
    let c1 = null, c2 = null;
    try {
      const c = await Spicetify.colorExtractor(t.uri);
      const pick = (...ks) => ks.map((k) => hex2rgb(c && c[k])).find(Boolean);
      c1 = pick("VIBRANT", "PROMINENT", "LIGHT_VIBRANT", "VIBRANT_NON_ALARMING");
      c2 = pick("PROMINENT", "DESATURATED", "DARK_VIBRANT", "LIGHT_VIBRANT");
    } catch (e) {}
    if (!c1 && t.image) {
      try {
        const id = t.image.split(":").pop();
        const [a, b] = await colorsFromImage(/^https?:/.test(t.image) ? t.image : "https://i.scdn.co/image/" + id);
        c1 = hex2rgb(a); c2 = hex2rgb(b);
      } catch (e) {}
    }
    if (!c1) return ["#3b2f63", "#1f4d5c", "#1db954", "#5ef28d"];
    if (!c2 || cdist(c1, c2) < 60) { const h = rgb2hsl(c1); c2 = hsl2rgb([(h[0] + 40) % 360, Math.max(0.35, h[1]), Math.max(0.25, h[2] * 0.7)]); }
    const h = rgb2hsl(c1);
    const cur = hsl2rgb([h[0], Math.max(0.55, h[1]), Math.min(0.5, Math.max(0.36, h[2]))]); // readable on white paper
    const curN = hsl2rgb([h[0], Math.max(0.65, h[1]), 0.64]); // readable on dark paper (night mode)
    return [rgb2hex(c1), rgb2hex(c2), rgb2hex(cur), rgb2hex(curN)];
  }

  // ---- finding the score (Wikimedia Commons, straight from Spotify, no helper) ----
  async function getJson(url) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      return await Spicetify.CosmosAsync.get(url); // Spotify's own request
    }
  }
  async function commons(q, accept) {
    // the search also returns recordings and pictures, so ask for documents (PDFs) only; fall back to a plain search
    const run = async (extra) => getJson("https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
      action: "query", generator: "search", gsrnamespace: "6", gsrlimit: "50", gsrsearch: q + " " + extra, prop: "imageinfo",
      iiprop: "url|size|mime|extmetadata", iiextmetadatafilter: "ImageDescription|Credit|Artist", format: "json", origin: "*",
    })).catch(() => null);
    let d = null;
    for (const extra of ["filemime:application/pdf", "filetype:office", "pdf"]) {
      const r = await run(extra);
      if (r && r.query && Object.keys(r.query.pages || {}).length) { d = r; break; }
    }
    return Object.values((d && d.query && d.query.pages) || {}).sort((a, b) => a.index - b.index).map((p) => {
      const i = p.imageinfo && p.imageinfo[0];
      if (!i || !(/\.pdf$/i.test(i.url) || i.mime === "application/pdf") || (i.size || 0) > 30e6) return null; // PDFs only, nothing huge
      const title = p.title.replace(/^File:/, "").replace(/\.pdf$/i, "");
      const meta = Object.values(i.extmetadata || {}).map((m) => (m && m.value) || "").join(" ").replace(/<[^>]+>/g, " ");
      const text = title + " " + meta;
      if (!accept(title + " " + meta)) return null; // the song must be in the sheet's name or description
      return { title, url: i.url, text };
    }).filter(Boolean);
  }
  async function findScores(track) {
    const P = smParse(track.title, track.artists);
    const qs = smQueries(P).slice(0, 7);
    const lists = await Promise.all(qs.map((q) => commons(q, (text) => smAccept(text, P))));
    const found = new Map();
    lists.forEach((files, qi) => files.forEach((f) => {
      const e = found.get(f.url) || { ...f, score: 0 };
      e.score += Math.max(1, 4 - qi * 0.5); // matched an earlier, more specific query
      found.set(f.url, e);
    }));
    const opNums = (P.toks || []).filter((w) => /^\d{2,}$/.test(w));
    found.forEach((e) => {
      if (P.comp && smHasComp(e.text, P.comp)) e.score += 2;                          // composer named in the sheet
      if (P.nickToks.length && smRel(e.text, P.nickToks) === 1) e.score += 2;         // nickname in the sheet
      if (opNums.length && smRel(e.text, opNums) === 1) e.score += 2;                 // opus / catalogue number in the sheet
      if (/imslp|petrucci|pmlp/i.test(e.text)) e.score += 1;
    });
    return [...found.values()].sort((a, b) => b.score - a.score).slice(0, 6).map(({ title, url }) => ({ title, url }));
  }

  async function fetchPdf(url) {
    const r = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(90000) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const blob = await r.blob();
    if ((await blob.slice(0, 5).text()) !== "%PDF-") throw new Error("not a PDF");
    return blob;
  }
  async function analyzePage(doc, n) {
    const pg = await doc.getPage(n);
    const base = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: 1200 / base.width });
    const cv = document.createElement("canvas");
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    return smAnalyze(cv).map((b) => ({ ...b, p: n - 1 }));
  }

  // tempo marking ("= 56") and printed time signature, when the PDF carries real text (engraved scores do, scans do not)
  async function readMeta(doc) {
    const m = { bpm: null, beats: [] };
    try {
      for (let p = 1; p <= Math.min(doc.numPages, 2); p++) {
        const tc = await (await doc.getPage(p)).getTextContent();
        const txt = tc.items.map((i) => i.str).join(" ");
        if (!m.bpm) { const t = txt.match(/(?:[\u2669\u266a]|\bq\b|M\.?\s?M\.?)\.?\s*=\s*(\d{2,3})\b/); if (t && +t[1] >= 30 && +t[1] <= 240) m.bpm = +t[1]; }
        if (!m.beats.length) {
          const t = txt.match(/\b(2|3|4|6|9|12)\s*\/\s*(2|4|8)\b/);
          if (t) { const n = +t[1], d = +t[2]; m.beats = [(n * 4) / d]; if (d === 8 && n % 3 === 0) m.beats.push(n / 3); }
        }
      }
    } catch (e) {}
    return m;
  }
  // a stray staff (incipit, example, title block) is a line of one bar in the middle of a score: not music to follow
  function pruneStray(bars) {
    const key = (b) => b.p + ":" + Math.round(b.y * 100), cnt = new Map();
    bars.forEach((b) => cnt.set(key(b), (cnt.get(key(b)) || 0) + 1));
    if (bars.length < 24) return bars;
    const lastKey = key(bars[bars.length - 1]);
    return bars.filter((b) => cnt.get(key(b)) > 1 || key(b) === lastKey || b.fin);
  }

  // a thick final barline ends a movement
  function smSplit(bars) {
    const segs = [];
    let cur = [];
    bars.forEach((b) => { cur.push(b); if (b.fin) { segs.push(cur); cur = []; } });
    if (cur.length) segs.push(cur);
    // a stray "final barline" (a title block, a double bar inside a piece) must not make a tiny part of its own:
    // parts of fewer than 24 bars are joined onto the part before them (or after, for the first one)
    for (let k = 0; k < segs.length && segs.length > 1; ) {
      if (segs[k].length >= 24) { k++; continue; }
      if (k > 0) { segs[k - 1] = segs[k - 1].concat(segs[k]); segs.splice(k, 1); }
      else { segs[1] = segs[0].concat(segs[1]); segs.splice(0, 1); }
    }
    return segs;
  }
  // which part of the PDF is playing: the movement number in the title, else the part whose bar count best fits the
  // recording (Spotify's bar count comes from its tempo and time signature analysis; it may be half or double)
  function smPick(segs, mv, M, dur) {
    const flat = segs.flat();
    if (segs.length < 2) return { bars: flat, note: "" };
    // a part has to be a believable length for this recording (about 6 to 150 bars per minute), else it is not the piece
    const bpm = (n) => (dur ? n / (dur / 60000) : 30);
    const fits = (seg) => bpm(seg.length) >= 6 && bpm(seg.length) <= 150;
    if (dur && !segs.some(fits)) return { bars: flat, note: "" };
    let best = -1, bd = 1e9;
    if (M >= 4) segs.forEach((s, k) => { const d = Math.abs(Math.log2(s.length / M)); if (d < bd) { bd = d; best = k; } });
    if (mv !== null && mv < segs.length && fits(segs[mv]) && (M < 4 || Math.abs(Math.log2(segs[mv].length / M)) <= 1.6)) return { bars: segs[mv], note: "Movement " + (mv + 1) + " of " + segs.length };
    if (best >= 0 && bd <= 1.2) return { bars: segs[best], note: "Part " + (best + 1) + " of " + segs.length };
    return { bars: flat, note: "" };
  }

  // ---- one job per track: find, stream into memory, read bars, build the time map ----
  const S = { open: false, track: null, shown: null, jobs: new Map(), colors: new Map(), pagesDoc: null, pageEls: [], lastKey: "", lastScroll: 0, instant: true, raf: 0 };
  const touch = (j) => { if (S.shown === j && S.el) paint(); };

  function currentTrack() {
    const d = Spicetify.Player.data || {}, it = d.item || d.track;
    if (!it || !it.uri) return null;
    const md = it.metadata || {};
    const artists = [...new Set((it.artists || []).map((a) => a.name).concat(md.artist_name ? [md.artist_name] : []).filter(Boolean))];
    return {
      uri: it.uri, title: it.name || md.title || "", artists, image: md.image_xlarge_url || md.image_url || "",
      dur: Spicetify.Player.getDuration() || Number(md.duration) || 0, isTrack: /^spotify:track:/.test(it.uri),
    };
  }
  function ensureJob(track) {
    let j = S.jobs.get(track.uri);
    if (j) return j;
    j = { track, state: "searching", tok: 0, cands: [], ci: 0, blob: null, doc: null, bars: [], anchors: [], grid: null, label: "", note: "" };
    S.jobs.set(track.uri, j);
    while (S.jobs.size > 5) S.jobs.delete(S.jobs.keys().next().value);
    startJob(j);
    return j;
  }
  async function startJob(j) {
    try {
      if (!j.track.isTrack || !j.track.title) { j.state = "none"; return touch(j); }
      j.gridP = smGrid(j.track.uri); // Spotify's bar timings for this recording, fetched in parallel
      j.beatsP = smBeats(j.track);   // the recording's own beat times from the open music databases, also in parallel
      const known = readJSON("sm:src:" + j.track.uri);
      j.cands = known ? [known] : await findScores(j.track);
      let ok = j.cands.length ? await tryFrom(j, 0) : false;
      if (!ok && known) { j.cands = await findScores(j.track); ok = j.cands.length ? await tryFrom(j, 0) : false; }
      if (!ok) { j.state = "none"; j.doc = j.blob = null; touch(j); }
    } catch (e) { j.state = "error"; touch(j); }
  }
  // try the matches in order until one is a readable score
  async function tryFrom(j, start) {
    const tok = ++j.tok, n = j.cands.length;
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n, c = j.cands[i];
      j.state = "loading"; j.label = c.title; touch(j);
      try {
        const blob = await fetchPdf(c.url);
        const doc = await (await smLoadPdfJs()).getDocument({ data: await blob.arrayBuffer() }).promise;
        if (j.tok !== tok) return true;
        if (doc.numPages > 80) continue;
        const cached = readJSON("sm:bars6:" + c.url);
        let pb = [];
        if (cached && cached.length === doc.numPages) pb = cached;
        else {
          let found = 0; // a real score has bars on its first pages; a book does not
          for (let p = 1; p <= Math.min(doc.numPages, 6) && found < 6; p++) { const b = await analyzePage(doc, p); pb.push(b); found += b.length; }
          if (found < 6) continue; // not a score (a book, a scan whose staves cannot be read)
        }
        j.blob = blob; j.doc = doc; j.ci = i; j.bars = []; j.anchors = [];
        j.state = "reading"; touch(j); // the pages show now; the bar highlight follows once the bars are read
        for (let p = pb.length + 1; p <= doc.numPages; p++) { pb.push(await analyzePage(doc, p)); if (j.tok !== tok) return true; }
        if (!cached || cached.length !== doc.numPages) writeJSON("sm:bars6:" + c.url, pb);
        writeJSON("sm:src:" + j.track.uri, c);
        const gd = await j.gridP;
        j.grid = gd && gd.g.length >= 4 ? gd.g : null;
        j.span = gd && gd.s !== null ? { s: gd.s, e: gd.e } : null;
        const sm = await readMeta(doc);
        j.meta = { bpm: sm.bpm, tempo: gd && gd.tempo, beats: [...sm.beats, ...(gd && gd.ts ? [gd.ts] : [])] };
        const pick = smPick(smSplit(pruneStray(pb.flat())), smMovement(j.track.title), j.grid ? j.grid.length : 0, j.track.dur || Spicetify.Player.getDuration());
        j.bars = pick.bars; j.note = pick.note;
        if (!j.grid && j.bars.length) { // Spotify gave no bars: try the beats of the recording from the databases
          const ab = await Promise.race([j.beatsP || null, new Promise((r) => setTimeout(() => r(null), 4000))]);
          if (ab) { j.grid = smBarsFromBeats(ab.beats, j.bars.length, j.meta); if (j.meta && !j.meta.tempo) j.meta.tempo = ab.bpm; }
        }
        j.baseAnchors = j.bars.length ? smAnchors(j.bars.length, j.grid, j.track.dur || Spicetify.Player.getDuration() || 1, j.span, j.meta) : [];
        j.cal = readJSON("sm:cal:" + j.track.uri) || [];
        j.anchors = j.bars.length ? smCalibrate(j.bars.length, j.baseAnchors, j.cal) : [];
        j.state = "ready"; touch(j);
        return true;
      } catch (e) { /* unreadable file: next candidate */ }
    }
    return false;
  }

  // where in the score the recording is at time t (ms): { bar, i, y, h }
  function posAt(j, t) {
    const A = j.anchors, N = j.bars.length;
    let b;
    if (t <= A[0].t) b = 0;
    else if (t >= A[A.length - 1].t) b = N - 0.001;
    else {
      let lo = 0, hi = A.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (A[m].t <= t) lo = m; else hi = m; }
      b = lo + (t - A[lo].t) / (A[hi].t - A[lo].t || 1);
    }
    b = Math.max(0, Math.min(N - 0.001, b));
    const k = Math.floor(b), br = j.bars[k];
    return { bar: br, i: k, y: br.y, h: br.h + 0.012 };
  }

  // ---- overlay UI ----
  function buildUI() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);
    const ov = document.createElement("div");
    ov.className = "sm-ov";
    ov.hidden = true;
    ov.innerHTML = `
      <div class="sm-bg"><i class="sm-b1"></i><i class="sm-b2"></i><i class="sm-b3"></i><div class="sm-shade"></div></div>
      <div class="sm-head">
        <div><div class="sm-title"></div><div class="sm-sub"></div><div class="sm-status"></div></div>
        <div class="sm-actions">
          <button class="sm-icon" data-a="sync" title="Sync highlight: click then choose the bar playing now" hidden>${ICON_SYNC}</button>
          <button class="sm-icon" data-a="next" title="Try another score" hidden>${ICON_NEXT}</button>
          <button class="sm-icon" data-a="night" title="Night mode">${ICON_MOON}</button>
          <button class="sm-icon" data-a="dl" title="Download sheet music" disabled>${ICON_DL}</button>
        </div>
      </div>
      <div class="sm-scroll"><div class="sm-pages"></div><div class="sm-msg"></div></div>`;
    document.body.appendChild(ov);
    S.el = ov;
    S.titleEl = ov.querySelector(".sm-title");
    S.subEl = ov.querySelector(".sm-sub");
    S.statusEl = ov.querySelector(".sm-status");
    S.msgEl = ov.querySelector(".sm-msg");
    S.scroller = ov.querySelector(".sm-scroll");
    S.pagesEl = ov.querySelector(".sm-pages");
    S.nextBtn = ov.querySelector('[data-a="next"]');
    S.syncBtn = ov.querySelector('[data-a="sync"]');
    S.dlBtn = ov.querySelector('[data-a="dl"]');
    S.nightBtn = ov.querySelector('[data-a="night"]');
    S.night = readJSON("sm:night") === true;
    applyNight();
    S.hl = document.createElement("div");
    S.hl.className = "sm-hl";

    S.io = new IntersectionObserver((entries) => entries.forEach(async (e) => {
      const w = e.target, doc = S.pagesDoc;
      if (!e.isIntersecting || w._done || !doc) return;
      w._done = true;
      try {
        const pg = await doc.getPage(w._n);
        const base = pg.getViewport({ scale: 1 });
        const vp = pg.getViewport({ scale: (Math.min((S.scroller.clientWidth || 900) - 48, 860) / base.width) * (window.devicePixelRatio || 1) });
        const c = document.createElement("canvas");
        c.width = vp.width;
        c.height = vp.height;
        await pg.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
        if (S.pagesDoc !== doc) return;
        w.style.aspectRatio = base.width + "/" + base.height;
        w.appendChild(c);
        if (S.hl.parentNode === w) { S.lastKey = ""; S.instant = true; }
      } catch (err) {}
    }), { root: S.scroller, rootMargin: "1400px" });

    ov.addEventListener("click", (e) => {
      const b = e.target.closest("[data-a]");
      if (!b) return;
      if (b.dataset.a === "dl") download();
      if (b.dataset.a === "night") { S.night = !S.night; writeJSON("sm:night", S.night); applyNight(); }
      if (b.dataset.a === "next") nextScore();
      if (b.dataset.a === "sync") { S.syncMode = !S.syncMode; paint(); }
    });
    ["wheel", "touchmove", "pointerdown"].forEach((ev) => S.scroller.addEventListener(ev, () => (S.lastScroll = Date.now()), { passive: true }));
    // like clicking a lyric line: jump the song to that bar
    S.scroller.addEventListener("click", (e) => {
      const w = e.target.closest(".sm-page"), j = S.shown;
      if (!w || !j || j.state !== "ready") return;
      const r = w.getBoundingClientRect(), p = S.pageEls.indexOf(w);
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      let best = -1, bd = 1e9;
      j.bars.forEach((br, i) => {
        if (br.p !== p) return;
        const dy = Math.max(0, Math.abs(y - br.y) - br.h / 2), dx = x < br.x0 ? br.x0 - x : x > br.x1 ? x - br.x1 : 0;
        if (dx + dy * 3 < bd) { bd = dx + dy * 3; best = i; }
      });
      if (best < 0 || bd >= 0.06) return;
      if (e.altKey) { // Alt+click: forget the hand calibration
        j.cal = []; try { localStorage.removeItem("sm:cal:" + j.track.uri); } catch (er) {}
        j.anchors = j.baseAnchors; S.lastKey = ""; paint(); return;
      }
      if (e.shiftKey || S.syncMode) { // choose the bar that is playing right now to sync the highlight
        S.syncMode = false;
        const b = best + 0.5;
        j.cal = (j.cal || []).filter((c) => Math.abs(c.b - b) > 1 && Math.abs(c.t - Spicetify.Player.getProgress()) > 1500);
        j.cal.push({ b, t: Spicetify.Player.getProgress() });
        writeJSON("sm:cal:" + j.track.uri, j.cal);
        j.anchors = smCalibrate(j.bars.length, j.baseAnchors, j.cal); S.lastKey = ""; paint(); return;
      }
      Spicetify.Player.seek(Math.round(j.anchors[best].t));
    });
    window.addEventListener("resize", layout);
  }

  function applyNight() {
    if (!S.el) return;
    S.el.classList.toggle("sm-night", !!S.night);
    S.nightBtn.classList.toggle("on", !!S.night);
    S.nightBtn.title = S.night ? "Night mode: on (click for white pages)" : "Night mode: off (click for dark pages)";
  }
  function layout() {
    if (!S.el) return;
    const m = document.querySelector(".Root__main-view") || document.querySelector(".main-view-container") || document.querySelector("main");
    const r = m ? m.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
    Object.assign(S.el.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  }

  function mountPages(j) {
    S.io.disconnect();
    S.pagesEl.innerHTML = "";
    S.pageEls = [];
    S.pagesDoc = j && j.doc;
    S.lastKey = ""; S.instant = true;
    if (!S.pagesDoc) return;
    const doc = j.doc;
    let sized = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const w = document.createElement("div");
      w.className = "sm-page";
      w._n = n;
      S.pagesEl.appendChild(w);
      S.pageEls.push(w);
      S.io.observe(w);
      doc.getPage(n).then((pg) => {
        if (S.pagesDoc !== doc) return;
        const v = pg.getViewport({ scale: 1 });
        w.style.aspectRatio = v.width + "/" + v.height;
        if (++sized === doc.numPages) { S.lastKey = ""; S.instant = true; } // all heights known: scroll to the music again
      }).catch(() => { sized++; });
    }
  }

  const MESSAGES = {
    searching: "Finding the sheet music...", loading: "Loading the score...", reading: "Reading the bars...",
    none: "No sheet music found for this track.", error: "Could not load the sheet music.",
  };
  function paint() {
    const t = S.track, j = S.shown;
    S.titleEl.textContent = t ? t.title : "";
    S.subEl.textContent = t ? t.artists.slice(0, 2).join(", ") : "";
    const doc = j ? j.doc : null;
    if (S.pagesDoc !== doc) mountPages(j);
    let status = "";
    if (!t) status = "";
    else if (j && j.state === "ready") status = (j.bars.length ? [j.note, j.cal && j.cal.length ? "Highlight adjusted (Alt+click any bar to reset)" : j.grid ? "Synced to recording" : "Estimated tempo - if highlight drifts, click clock icon and choose the bar playing (or Shift+click)"].filter(Boolean).join(" - ") : "Could not find the bars in this score");
    else if (j) status = MESSAGES[j.state] || "";
    if (S.syncMode && j && j.state === "ready") status = "Choose the bar that is playing right now to sync highlight";
    S.statusEl.textContent = doc ? status : "";
    S.syncBtn.hidden = !(j && j.state === "ready" && j.bars.length);
    S.syncBtn.style.background = S.syncMode ? "rgba(255,255,255,.35)" : "";
    S.msgEl.textContent = doc ? "" : !t ? "Play a song to see its sheet music." : j ? MESSAGES[j.state] || "" : MESSAGES.searching;
    S.nextBtn.hidden = !(j && j.cands.length > 1);
    S.dlBtn.disabled = !(j && j.blob);
  }

  function place() {
    const j = S.shown;
    if (!j || j.state !== "ready" || !j.bars.length || S.pagesDoc !== j.doc) { S.hl.remove(); return; }
    const q = posAt(j, Spicetify.Player.getProgress());
    const wrap = S.pageEls[q.bar.p];
    if (!wrap) return;
    if (S.hl.parentNode !== wrap) wrap.appendChild(S.hl);
    S.hl.style.left = q.bar.x0 * 100 + "%";
    S.hl.style.width = (q.bar.x1 - q.bar.x0) * 100 + "%";
    S.hl.style.top = (q.y - q.h / 2) * 100 + "%";
    S.hl.style.height = q.h * 100 + "%";
    const key = q.bar.p + ":" + Math.round(q.y * 50);
    if (key !== S.lastKey) { // new line of music: bring it into view, unless you are scrolling yourself
      S.lastKey = key;
      if (S.instant || Date.now() - S.lastScroll > 3000) {
        S.scroller.scrollTo({ top: wrap.offsetTop + q.y * wrap.offsetHeight - S.scroller.clientHeight * 0.4, behavior: S.instant ? "auto" : "smooth" });
      }
      S.instant = false;
    }
  }
  function frame() {
    S.raf = 0;
    if (!S.open) return;
    try { place(); } catch (e) {}
    S.raf = requestAnimationFrame(frame);
  }

  async function applyColors(t) {
    if (!t || !S.el) return;
    let c = S.colors.get(t.uri);
    if (!c) { c = await trackColors(t); S.colors.set(t.uri, c); }
    if (S.track && S.track.uri === t.uri) {
      S.el.style.setProperty("--sm-c1", c[0]);
      S.el.style.setProperty("--sm-c2", c[1]);
      S.el.style.setProperty("--sm-cur", c[2] || "#1db954");
      S.el.style.setProperty("--sm-curn", c[3] || "#5ef28d");
    }
  }

  function download() {
    const j = S.shown;
    if (!j || !j.blob) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(j.blob);
    a.download = ((j.label || j.track.title || "sheet music").replace(/[\\/:*?"<>|]+/g, " ").trim() || "sheet music") + ".pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  async function nextScore() {
    const j = S.shown;
    if (!j || j.cands.length < 2) return;
    if (!(await tryFrom(j, (j.ci + 1) % j.cands.length))) { j.state = "none"; j.doc = j.blob = null; touch(j); }
  }

  // ---- open / close / track changes ----
  let button;
  function open() {
    if (!S.el) buildUI();
    S.open = true;
    try { localStorage.setItem("sm:used", "1"); } catch (e) {} // from now on scores are prepared in the background, so they are ready when you press
    S.track = currentTrack();
    S.shown = S.track ? ensureJob(S.track) : null;
    S.openPath = (Spicetify.Platform && Spicetify.Platform.History && Spicetify.Platform.History.location && Spicetify.Platform.History.location.pathname) || location.pathname;
    layout();
    S.el.hidden = false;
    S.instant = true; S.lastKey = "";
    paint();
    applyColors(S.track);
    if (!S.raf) S.raf = requestAnimationFrame(frame);
    if (button) button.active = true;
    const btn = document.querySelector("[data-sm-btn]");
    if (btn) { btn.style.color = "#1db954"; btn.setAttribute("aria-pressed", "true"); }
  }
  function close() {
    S.open = false; S.syncMode = false;
    if (S.el) S.el.hidden = true;
    if (button) button.active = false;
    const btn = document.querySelector("[data-sm-btn]");
    if (btn) { btn.style.color = ""; btn.setAttribute("aria-pressed", "false"); }
  }
  function onSong() {
    const t = currentTrack();
    S.track = t;
    S.instant = true; S.lastKey = "";
    if (t && (S.open || readJSON("sm:used"))) {
      S.shown = ensureJob(t);
      if (S.el) applyColors(t);
    } else S.shown = t ? S.jobs.get(t.uri) || null : null;
    if (S.open) paint();
  }

  function hookHistory() {
    if (S.historyHooked) return;
    try {
      const hist = Spicetify.Platform && Spicetify.Platform.History;
      if (hist && typeof hist.listen === "function") {
        hist.listen(() => { if (S.open) close(); });
        S.historyHooked = true;
      }
    } catch (e) {}
  }

  // When another menu, sidebar link, or view button is pressed: switch from sheet music (just like Lyrics)
  document.addEventListener("click", (e) => {
    if (!S.open) return;
    if (S.el && S.el.contains(e.target)) return;
    if (e.target.closest("[data-sm-btn]") || (button && button.element && button.element.contains(e.target))) return;
    const isControl = e.target.closest(
      "[data-testid='control-button-playpause'], [data-testid='control-button-skip-back'], [data-testid='control-button-skip-forward'], [data-testid='control-button-shuffle'], [data-testid='control-button-repeat'], [data-testid='playback-progressbar'], .playback-bar, [data-testid='volume-bar'], .volume-bar, .main-playPauseButton-button, .player-controls__buttons"
    );
    if (isControl) return;
    close();
  }, true);

  window.addEventListener("popstate", () => { if (S.open) close(); });
  window.addEventListener("hashchange", () => { if (S.open) close(); });

  try { indexedDB.deleteDatabase("sheetmusic"); } catch (e) {} // older versions stored PDFs; scores are streamed now
  const toggle = () => (S.open ? close() : open());
  button = new Spicetify.Playbar.Button("Sheet music", ICON_BTN, toggle, false, false);
  // Spotify builds with scrambled class names: find the right-hand control group through its buttons (queue, lyrics, devices...)
  function ensureButton() {
    try {
      if (document.querySelector("[data-sm-btn]")) return;
      if (button && button.element && document.contains(button.element)) return;
      const labelOf = (b) => (b.getAttribute("aria-label") || b.getAttribute("title") || "") + " " + (b.getAttribute("data-testid") || "");
      const anchors = [...document.querySelectorAll("footer button, [data-testid='now-playing-bar'] button, button")]
        .filter((b) => /queue|lyrics|connect|devices|now.playing|mini.?player|full.?screen/i.test(labelOf(b)) && b.getBoundingClientRect().top > innerHeight - 140);
      let a = anchors.find((b) => /queue/i.test(labelOf(b))) || anchors[0];
      if (!a) { const old = document.querySelector(".main-nowPlayingBar-extraControls"); if (!old) return; a = old.firstElementChild; if (!a) return; }
      const b = a.cloneNode(false); // copies the look of the neighbouring button
      b.removeAttribute("id"); b.removeAttribute("aria-pressed"); b.removeAttribute("data-testid");
      b.setAttribute("data-sm-btn", "1"); b.setAttribute("aria-label", "Sheet music"); b.title = "Sheet music";
      b.setAttribute("aria-pressed", S.open ? "true" : "false");
      b.innerHTML = ICON_BTN;
      b.style.cursor = "pointer";
      if (S.open) b.style.color = "#1db954";
      b.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
      a.parentNode.insertBefore(b, a);
    } catch (e) { console.warn("[sheetmusic]", e); }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.open) close(); });
  setInterval(() => {
    ensureButton();
    hookHistory();
    const curPath = (Spicetify.Platform && Spicetify.Platform.History && Spicetify.Platform.History.location && Spicetify.Platform.History.location.pathname) || location.pathname;
    if (S.open && S.openPath && curPath !== S.openPath) close();
    const b = document.querySelector("[data-sm-btn]");
    if (b) {
      b.style.color = S.open ? "#1db954" : "";
      b.setAttribute("aria-pressed", S.open ? "true" : "false");
    }
  }, 1000);
  Spicetify.Player.addEventListener("songchange", () => setTimeout(onSong, 150));
  hookHistory();
  setInterval(() => { if (S.open) layout(); }, 1000);
  onSong();
})();