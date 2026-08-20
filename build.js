// Static site generator for a personal notebook.
// Each post lives in posts/<section-slug>/ as a folder of .html files. Metadata
// is read from the HTML itself. The generator writes:
//   /                        -> home: the Notes stream (date-sorted)
//   /working-papers/         -> the Working Papers section (fixed order)
//   /<section-slug>/<slug>.html -> a single post
//
// Per-post metadata is read (in order of preference) from:
//   title       -> <meta name="title">, else <title>, else first <h1>, else filename
//   date        -> <meta name="date" content="YYYY-MM-DD">, else file modified time
//   description -> <meta name="description">, else first <p>, else ""
//   pinned      -> <meta name="pinned" content="true">  (still read; no longer surfaced)
//
// You can write each post as a normal, complete HTML document. Only the contents
// of <body> are rendered (the rest of your <head> is ignored), so the shared
// theme stays consistent across posts.

import { readdir, readFile, writeFile, mkdir, rm, copyFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = path.join(ROOT, "posts");
const DIST_DIR = path.join(ROOT, "dist");
const STYLES_SRC = path.join(ROOT, "src", "styles.css");

// ---- Site configuration -----------------------------------------------------
const SITE = {
  // Site name, used in page <title> chrome.
  name: "Risk Thinking",
  // Wordmark shown top-left in the nav on every page (links home).
  wordmark: "Terence Bumah",
  // The big hero on the home page. Use *stars* to accent a word.
  homeHeading: "Applying Risk Thinking in *Everyday Life*",
  // One line under the home hero.
  subtext: "Applying 20 years of institutional risk expertise to everyday life, helping people make smarter decisions about their health, money, business, and life.",
  // Used for the <meta name="description"> SEO tag on the home page.
  description:
    "Risk Thinking by Terence Bumah. Think like a risk officer: twenty years managing risk in financial services, applied to everyday life. Notes on health, money, business and personal growth.",
  author: "Terence Bumah",
  // Contact / social links shown in the footer of every page.
  links: [
    { label: "Email", href: "mailto:contact@terencebumah.com" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/terencebumah" },
    { label: "Substack", href: "https://bumah.substack.com" },
  ],
};

// Two sections, one folder each under posts/:
//   notes          -> the main stream (lands on the home page, date-sorted)
//   working-papers -> longer-form risk frameworks, in a fixed order
// A curated section (working-papers) carries an `order` array of category
// labels and runs in that order instead of by date.
const BLOGS = [
  {
    slug: "notes",
    name: "Posts",
    section: "posts",
    heroHeading: "*Posts*.",
    description:
      "Short notes on the risks of everyday life, and how to stay ahead of them, by Terence Bumah.",
  },
  {
    slug: "working-papers",
    name: "Frameworks",
    section: "working-papers",
    heroHeading: "*Frameworks*",
    description:
      "Longer-form risk frameworks for enterprises, strategy, longevity and startups, by Terence Bumah.",
    order: ["Enterprises", "Strategy", "AI", "Longevity", "Startups"],
  },
];

// ---- Tiny HTML helpers ------------------------------------------------------

// Escape text destined for HTML attribute/text contexts.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Replace *word* with an accented <em>word</em>.
function accent(str) {
  return escapeHtml(str).replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// Decode the HTML entities we actually use in posts, so plain-text excerpts
// show real characters (™, ·, →) instead of literal "&trade;" strings.
function decodeEntities(s) {
  const map = {
    "&mdash;": "\u2014", "&ndash;": "\u2013", "&trade;": "\u2122",
    "&middot;": "\u00b7", "&rarr;": "\u2192", "&nbsp;": " ",
    "&minus;": "\u2212", "&euro;": "\u20ac", "&hellip;": "\u2026",
    "&rsquo;": "\u2019", "&lsquo;": "\u2018", "&ldquo;": "\u201c",
    "&rdquo;": "\u201d", "&deg;": "\u00b0", "&times;": "\u00d7",
    "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
  };
  return s
    .replace(/&(?:#39|[a-z]+);/gi, (m) => (m in map ? map[m] : m))
    .replace(/&amp;/g, "&");
}

// Strip tags to get plain text (used for excerpts).
function stripTags(html) {
  return decodeEntities(
    html
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

// Build a plain-text intro excerpt from a post's body HTML.
function makeExcerpt(html, maxChars = 260) {
  const text = stripTags(html);
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  return cut.slice(0, cut.lastIndexOf(" ")).trim() + "\u2026";
}

function getMeta(html, name) {
  // Match content wrapped in either quote type, and read until the SAME quote
  // closes it — so an apostrophe inside a double-quoted value (e.g. "Here's")
  // doesn't end the value early.
  const re = new RegExp(
    `<meta\\s+name=["']${name}["']\\s+content=(["'])([\\s\\S]*?)\\1`,
    "i"
  );
  const m = html.match(re);
  return m ? m[2].trim() : null;
}

function getTitleTag(html) {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]) : null;
}

function getFirstH1(html) {
  const m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return m ? stripTags(m[1]) : null;
}

function getFirstParagraph(html) {
  const m = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
  return m ? stripTags(m[1]) : null;
}

// Remove HTML comments (they never render and can contain literal tag text
// like "<body>" that would otherwise confuse the extractors below).
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

// Return the inner <body> if present, else the whole document.
function getBody(html) {
  const m = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return m ? m[1] : html;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/\.html?$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00");
  if (isNaN(d)) return "";
  return d.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ---- Page templates ---------------------------------------------------------

// Top navigation. `active` is a section slug: "notes" or "working-papers".
function nav(active) {
  const item = (name, href, key) =>
    `<a class="nav-link${active === key ? " is-active" : ""}" href="${href}">${escapeHtml(name)}</a>`;
  return `  <nav class="site-nav">
    <a class="nav-brand" href="/">${escapeHtml(SITE.wordmark || SITE.name)}</a>
    <div class="nav-links">${item("ART", "/", "notes")}${item("Frameworks", "/working-papers/", "working-papers")}${item("Coaching", "/work/", "work")}${item("ULTM8", "/ultm8/", "ultm8")}${item("About", "/about/", "about")}</div>
  </nav>`;
}

function layout({ title, description, body, active = "", heroHtml = "", wide = false }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description || SITE.description)}">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
${nav(active)}
${heroHtml}
  <main class="container${wide ? " container-home" : ""}">
${body}
  </main>
  <footer class="site-footer${wide ? " site-footer-home" : ""}">
    ${
      SITE.links && SITE.links.length
        ? `<nav class="contact-links">${SITE.links
            .map((l) => `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`)
            .join("")}</nav>`
        : ""
    }
    <p>&copy; ${new Date().getFullYear()} ${escapeHtml(SITE.author)}</p>
    <p class="collab-note">Published in collaboration with Claude.</p>
  </footer>
</body>
</html>
`;
}

function blogHero(blog) {
  return `  <header class="site-hero">
    <h1 class="hero-heading">${accent(blog.heroHeading)}</h1>
  </header>`;
}

// Maps each category to a CSS class that colours the card cover + label.
const CAT_CLASS = {
  Health: "cat-health",
  Money: "cat-money",
  Business: "cat-business",
  "Personal Growth": "cat-growth",
};

// One card in a stream. Notes carry a series number ("No. 12") on the cover;
// working papers show their category label instead. `showCat` falls back to the
// section name when a post has no category label of its own.
// One category motif per note card: a single-stroke, category-coloured line
// drawing of the everyday scene (pulse / coins / bars / sprout), reused across
// every post in that category so the grid reads as one coherent system.
const CARD_ART = {
  Health: `<g fill="none" stroke="#ffffff" stroke-opacity=".24" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="48,150 168,150 196,150 216,100 240,206 262,150 288,150 322,150 346,126 366,174 386,150 432,150"/></g>`,
  Money: `<g fill="none" stroke="#ffffff" stroke-opacity=".26" stroke-width="2.6"><ellipse cx="240" cy="112" rx="56" ry="19"/><ellipse cx="240" cy="150" rx="56" ry="19"/><ellipse cx="240" cy="188" rx="56" ry="19"/><line x1="184" y1="112" x2="184" y2="188"/><line x1="296" y1="112" x2="296" y2="188"/></g>`,
  Business: `<g fill="#ffffff" fill-opacity=".2"><rect x="150" y="178" width="42" height="74" rx="4"/><rect x="212" y="146" width="42" height="106" rx="4"/><rect x="274" y="110" width="42" height="142" rx="4"/><rect x="336" y="74" width="42" height="178" rx="4"/></g>`,
  "Personal Growth": `<g fill="none" stroke="#ffffff" stroke-opacity=".26" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M240 234 V120"/><path d="M240 170 C214 170 190 156 182 126 C214 124 236 144 240 170 Z"/><path d="M240 148 C266 148 290 134 298 104 C266 102 244 122 240 148 Z"/></g>`,
};

function cardMotif(category) {
  const motif = CARD_ART[category];
  if (!motif) return "";
  return `<svg class="card-svg" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid meet" role="img" aria-hidden="true">${motif}</svg>`;
}

function streamItem(p, showCat) {
  const label = p.category || (showCat ? p.blogName : "");
  const catClass = CAT_CLASS[p.category] || "cat-default";
  const cover = p.number != null ? `ART #${p.number}` : label || "Paper";
  return `        <article class="card ${catClass}" data-topic="${escapeHtml(p.blogSlug)}">
          <a class="card-link" href="/${p.blogSlug}/${escapeHtml(p.slug)}.html">
            <div class="card-cover">${cardMotif(p.category)}<span class="card-num">${escapeHtml(cover)}</span></div>
            <div class="card-body">
              ${label ? `<span class="card-cat">${escapeHtml(label)}</span>` : ""}
              <h2 class="card-title">${escapeHtml(p.title)}</h2>
              ${p.date ? `<span class="card-date">${escapeHtml(fmtDate(p.date))}</span>` : ""}
            </div>
          </a>
        </article>`;
}

// Cover art for working papers. Each category gets a distinct, category-
// coloured SVG motif so the papers read as visual cards, not text rows.
const PAPER_ART = {
  Enterprises: {
    a: "#3a5a8c",
    b: "#243a63",
    motif: `<g fill="#ffffff"><circle cx="240" cy="150" r="80" fill="none" stroke="#ffffff" stroke-opacity=".22" stroke-width="2"/><circle cx="240" cy="72" r="10" opacity=".9"/><circle cx="301" cy="101" r="10" opacity=".9"/><circle cx="316" cy="167" r="10" opacity=".9"/><circle cx="274" cy="220" r="10" opacity=".9"/><circle cx="206" cy="220" r="10" opacity=".9"/><circle cx="164" cy="167" r="10" opacity=".9"/><circle cx="179" cy="101" r="10" opacity=".9"/><circle cx="240" cy="150" r="15" opacity=".95"/></g>`,
  },
  Strategy: {
    a: "#6b4e9e",
    b: "#452f6e",
    motif: `<g stroke="#ffffff" stroke-opacity=".28" stroke-width="2"><rect x="166" y="76" width="148" height="148" rx="8" fill="none"/><line x1="240" y1="76" x2="240" y2="224"/><line x1="166" y1="150" x2="314" y2="150"/></g><g fill="#ffffff" opacity=".9"><circle cx="203" cy="113" r="9"/><circle cx="277" cy="113" r="9"/><circle cx="203" cy="187" r="9"/><circle cx="277" cy="187" r="9"/></g>`,
  },
  AI: {
    a: "#2f6f7d",
    b: "#1f4a55",
    motif: `<g stroke="#ffffff" stroke-opacity=".2" stroke-width="1.6"><line x1="175" y1="100" x2="240" y2="120"/><line x1="175" y1="100" x2="240" y2="180"/><line x1="175" y1="150" x2="240" y2="120"/><line x1="175" y1="150" x2="240" y2="180"/><line x1="175" y1="200" x2="240" y2="120"/><line x1="175" y1="200" x2="240" y2="180"/><line x1="240" y1="120" x2="305" y2="150"/><line x1="240" y1="180" x2="305" y2="150"/></g><g fill="#ffffff" opacity=".92"><circle cx="175" cy="100" r="9"/><circle cx="175" cy="150" r="9"/><circle cx="175" cy="200" r="9"/><circle cx="240" cy="120" r="9"/><circle cx="240" cy="180" r="9"/><circle cx="305" cy="150" r="11"/></g>`,
  },
  Longevity: {
    a: "#2f7d5f",
    b: "#1f5540",
    motif: `<g fill="none" stroke="#ffffff"><polygon stroke-opacity=".32" stroke-width="2.4" points="314,181 269,226 211,226 166,181 166,119 211,76 269,76 314,119"/><g stroke-opacity=".16" stroke-width="1.4"><line x1="240" y1="150" x2="314" y2="181"/><line x1="240" y1="150" x2="269" y2="226"/><line x1="240" y1="150" x2="211" y2="226"/><line x1="240" y1="150" x2="166" y2="181"/><line x1="240" y1="150" x2="166" y2="119"/><line x1="240" y1="150" x2="211" y2="76"/><line x1="240" y1="150" x2="269" y2="76"/><line x1="240" y1="150" x2="314" y2="119"/></g></g><circle cx="240" cy="150" r="11" fill="#ffffff" opacity=".9"/>`,
  },
  Startups: {
    a: "#c07a2e",
    b: "#8a5320",
    motif: `<g fill="none" stroke="#ffffff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" opacity=".85"><polyline points="150,222 205,182 245,206 298,146 348,96"/><polyline points="322,96 348,96 348,122"/></g><g fill="#ffffff" opacity=".9"><circle cx="205" cy="182" r="6"/><circle cx="245" cy="206" r="6"/><circle cx="298" cy="146" r="6"/></g>`,
  },
};

// Per-paper cover overrides, keyed by slug. Used when a specific paper needs
// a motif that differs from its category default (e.g. a loop, not a graph).
const PAPER_ART_SLUG = {
  "product-innovation-loop": {
    a: "#c07a2e",
    b: "#8a5320",
    motif: `<g fill="none" stroke="#ffffff" stroke-opacity=".82" stroke-width=".42" stroke-linecap="round" stroke-linejoin="round" transform="translate(240 150) scale(8) translate(-12 -12)"><polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/></g>`,
  },
};

function paperCover(category, slug) {
  const art = PAPER_ART_SLUG[slug] || PAPER_ART[category] || PAPER_ART.Enterprises;
  const id = "pg-" + slugify(slug || category || "paper");
  return `<svg class="paper-svg" viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice" role="img" aria-hidden="true"><defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${art.a}"/><stop offset="1" stop-color="${art.b}"/></linearGradient></defs><rect width="480" height="300" fill="url(#${id})"/>${art.motif}</svg>`;
}

// One working paper: a wide horizontal card with a cover image on the left.
function paperItem(p) {
  const summary = p.excerpt || p.description || "";
  return `        <article class="paper" data-topic="${escapeHtml(p.blogSlug)}">
          <a class="paper-link" href="/${p.blogSlug}/${escapeHtml(p.slug)}.html">
            <div class="paper-cover">${paperCover(p.category, p.slug)}</div>
            <div class="paper-body">
              ${p.category ? `<span class="paper-cat">${escapeHtml(p.category)}</span>` : ""}
              <h2 class="paper-title">${escapeHtml(p.title)}</h2>
              ${summary ? `<p class="paper-excerpt">${escapeHtml(summary)}</p>` : ""}
              <span class="paper-more">Read the paper &rarr;</span>
            </div>
          </a>
        </article>`;
}

function postPage(post, blog) {
  const tags = post.tags.length
    ? `<ul class="tag-list">${post.tags
        .map((t) => `<li class="tag">${escapeHtml(t)}</li>`)
        .join("")}</ul>`
    : "";
  const backHref = blog.slug === "notes" ? "/" : `/${blog.slug}/`;
  const backText =
    blog.slug === "notes"
      ? "All posts"
      : blog.slug === "working-papers"
      ? "All frameworks"
      : `Back to ${blog.name}`;
  const body = `    <article class="post">
      <header class="post-header">
        <h1 class="post-title">${escapeHtml(post.title)}</h1>
        ${post.date ? `<p class="post-date">${escapeHtml(fmtDate(post.date))}</p>` : ""}
        ${tags}
      </header>
      <div class="post-body">
${post.body}
      </div>
      <p class="back"><a href="${backHref}">&larr; ${escapeHtml(backText)}</a></p>
    </article>`;
  return layout({
    title: post.title,
    description: post.description,
    body,
    active: blog.slug,
  });
}

// A section page: hero + a single stream (no filters). Used for
// survival-system and publications.
function sectionIndexPage(blog) {
  const isPapers = blog.section === "working-papers";
  const items = isPapers
    ? blog.posts.map(paperItem)
    : blog.posts.map((p) => streamItem(p, false));
  const feedHtml = blog.posts.length
    ? items.join("\n")
    : `        <p class="feed-empty">More coming soon.</p>`;
  const body = `    <section class="home-feed">
      <div class="${isPapers ? "papers" : "feed"}">
${feedHtml}
      </div>
    </section>`;
  return layout({
    title: `${blog.name} — ${SITE.name}`,
    description: blog.description,
    body,
    active: blog.slug,
    heroHtml: blogHero(blog),
    wide: true,
  });
}

function homePage() {
  const heroHtml = `  <header class="site-hero">
    <h1 class="hero-heading">${accent(SITE.homeHeading)}</h1>
    ${SITE.subtext ? `<p class="hero-subtext">${escapeHtml(SITE.subtext)}</p>` : ""}
  </header>`;

  // The Notes stream lands on the home page, newest first.
  const notes = BLOGS.find((b) => b.slug === "notes");
  const stream = notes ? notes.posts : [];

  const body = `    <section class="home-feed">
      <div class="feed">
${stream.map((p) => streamItem(p, false)).join("\n")}
      </div>
    </section>`;

  return layout({
    title: `${SITE.name} — ${SITE.author}`,
    description: SITE.description,
    body,
    active: "notes",
    heroHtml,
    wide: true,
  });
}

function aboutPage() {
  const photo = SITE.photo
    ? `<img src="${escapeHtml(SITE.photo)}" alt="${escapeHtml(SITE.author)}">`
    : `<div class="photo-ph"><span>TB</span><small>Your photo</small></div>`;

  const curve = `<svg class="risk-curve-svg" viewBox="0 0 300 210" role="img" aria-label="A distribution curve with the failure zone marked off on the left"><defs><clipPath id="rc-clip"><path d="M24 170 C 96 170 116 45 150 45 C 184 45 204 170 276 170 Z"/></clipPath></defs><path d="M24 170 C 96 170 116 45 150 45 C 184 45 204 170 276 170 Z" fill="var(--accent)" opacity="0.07"/><g clip-path="url(#rc-clip)"><rect x="24" y="45" width="62" height="125" fill="var(--accent)" opacity="0.22"/></g><line x1="86" y1="55" x2="86" y2="170" stroke="var(--accent)" stroke-width="1" stroke-dasharray="3 4" opacity="0.6"/><line x1="16" y1="170" x2="284" y2="170" stroke="var(--border)" stroke-width="1.5"/><path d="M24 170 C 96 170 116 45 150 45 C 184 45 204 170 276 170" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/><g opacity="0.75"><line x1="120" y1="192" x2="250" y2="192" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/><path d="M250 192 L244 188 M250 192 L244 196" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round"/></g></svg>`;

  const body = `    <article class="post about-page about-grid">
      <div class="about-main post-body">
        <h1 class="about-title">Applying Risk Thinking</h1>
        <p class="about-lede">Life is full of uncertainty. Starting a business, investing money, taking a new job or planning for retirement all involve decisions about the future, usually without complete information or guaranteed outcomes.</p>
        <p>For two decades, I managed risk across global financial institutions. My work involved thinking about what could go wrong, how likely it was, what the consequences might be and what could be done about it.</p>
        <p>I now apply that way of thinking to everyday life.</p>
        <p>Risk Thinking is a practical way of making decisions when the outcome is uncertain. It helps us think more clearly about our health, finances, businesses and the choices that shape our lives.</p>
        <p>In <a href="/">ART</a>, I explore how things go wrong in real-life situations and what we might do earlier, differently or better. In <a href="/working-papers/">Frameworks</a>, I set out structured ways to think through bigger risks.</p>
        <p>As a <a href="/work/">Product Coach</a>, I help founders and innovators build and launch products without making the mistakes that can sink them. Through <a href="/ultm8/">ULTM8</a>, I apply Risk Thinking to longevity, helping people protect their health and wealth over the long term.</p>
        <p>Nothing is guaranteed. But thinking more carefully about what could go wrong can improve our chances of making better decisions.</p>
      </div>
      <aside class="about-rail">
        <figure class="about-curve">
          ${curve}
          <figcaption>Success starts with eliminating failure.</figcaption>
        </figure>
        <figure class="about-photo">${photo}</figure>
      </aside>
    </article>`;

  return layout({
    title: `About — ${SITE.name}`,
    description:
      "Applying Risk Thinking by Terence Bumah: 20 years managing risk in global financial institutions, turned toward everyday decisions about health, money, business and life.",
    body,
    active: "about",
    wide: true,
  });
}

function workPage() {
  const benefit = (title, desc) =>
    `        <div class="work-card">
          <h3 class="wc-title">${title}</h3>
          <p class="wc-desc">${desc}</p>
        </div>`;

  const body = `    <article class="post text-page">
      <h1 class="about-title">Product Coach</h1>
      <div class="post-body">
        <p class="about-lede">I coach founders and innovators to launch and scale products, applying Risk Thinking to shape how they build.</p>
        <h2>Applying Risk Thinking to your vision</h2>
        <p>Most products don't fail because of code, project management, marketing or sales. They fail because someone built:</p>
        <ul>
          <li>a good product for the wrong audience, or</li>
          <li>a bad product for the right audience, or</li>
          <li>a good product for the right audience, grown the wrong way.</li>
        </ul>
        <p>I coach product teams to bring that same discipline to their work: identify what could go wrong, assess it critically, and make smarter decisions about what to build and how to grow it.</p>
      </div>
      <h2 class="work-h2">Benefits</h2>
      <div class="work-cards">
${benefit("Audience fit.", "Target the right users and customers, so you stop selling to everyone and start winning the right people.")}
${benefit("Value fit.", "Make sure the product gives your audience something they truly value and can't do without.")}
${benefit("Growth fit.", "Grow at the right time and the right pace, reaching more of the right people without launching too early or scaling before you're ready.")}
      </div>
      <h2 class="work-h2">Work with me</h2>
      <p>I coach through <a href="https://symmba.com" target="_blank" rel="noopener">Symmba</a>, my product studio. If you are building something and want a clear read on the risks, get in touch.</p>
      <p class="work-cta"><a href="https://symmba.com" target="_blank" rel="noopener">Symmba.com</a> &middot; <a href="mailto:contact@terencebumah.com?subject=Coaching%20enquiry">Email me</a> &middot; <a href="https://wa.me/85297125124" target="_blank" rel="noopener">WhatsApp</a></p>
    </article>`;

  return layout({
    title: `Coaching — ${SITE.name}`,
    description:
      "Terence Bumah coaches founders and innovators to launch and scale products, applying Risk Thinking to how they build.",
    body,
    active: "work",
  });
}

function ovanaPage() {
  const stat = (num, label) =>
    `        <div class="stat"><span class="stat-num">${escapeHtml(num)}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
  const get = (t) =>
    `          <li class="get-item"><svg class="get-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4 4 10-10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${escapeHtml(t)}</span></li>`;

  const body = `    <article class="detail-page">
      <a class="detail-back" href="/work/">&larr; Coaching</a>
      <span class="detail-kicker">Ovana &middot; Heart health</span>
      <h1 class="about-title detail-title">An intelligent blood pressure companion</h1>
      <div class="detail-body">
        <p class="about-lede">Hypertension is the world's most widespread chronic condition, and the real danger is how many people never find out until the damage is done.</p>
      </div>
      <div class="stats">
${stat("1.4B", "Adults live with hypertension, one in three worldwide.")}
${stat("46%", "Do not know they have it, over 600 million people.")}
${stat("23%", "Have it under control, only one in four.")}
      </div>
      <div class="detail-body">
        <p class="concept-label">The concept</p>
        <p>Ovana learns from your readings, understands your trends, and guides you every day to protect your heart.</p>
      </div>
      <div class="getblock">
        <p class="concept-label">What you get</p>
        <ul class="getlist">
${get("Know what is happening")}
${get("Know what affects you")}
${get("Know what to do next")}
${get("Know when you need help")}
        </ul>
      </div>
      <a class="detail-link" href="https://ovanahealth.com" target="_blank" rel="noopener">ovanahealth.com &rarr;</a>
    </article>`;

  return layout({
    title: `Ovana — ${SITE.name}`,
    description:
      "Ovana is an intelligent blood pressure companion that helps people catch high blood pressure early and protect their heart every day.",
    body,
    active: "work",
    wide: true,
  });
}

function ultm8Page() {
  const pillar = (name, desc) =>
    `<div class="pillar"><span class="pillar-name">${escapeHtml(name)}</span><span class="pillar-desc">${escapeHtml(desc)}</span></div>`;
  const group = (label, desc, items) =>
    `        <section class="pgroup">
          <p class="pgroup-kicker">${escapeHtml(label)}</p>
          <p class="pgroup-desc">${escapeHtml(desc)}</p>
          <div class="pillars">
            ${items.map(([n, d]) => pillar(n, d)).join("\n            ")}
          </div>
        </section>`;

  const body = `    <article class="detail-page">
      <span class="detail-kicker">ULTM8 &middot; Longevity</span>
      <h1 class="about-title detail-title">Add more life to your years</h1>
      <div class="def-box">
        <p class="def-label">What is ULTM8</p>
        <p class="def-text">A longevity companion that helps you build lasting health and wealth so you can live with more vitality and freedom, and make the most of the years you have.</p>
      </div>
      <div class="detail-body">
        <p class="about-lede">We are living longer than previous generations, but too many of those years are shaped by illness and financial insecurity.</p>
        <p>I started ULTM8 to help people build lasting health and wealth, so they can live with more vitality and freedom, and make the most of the years they have.</p>
        <p class="concept-label">The concept</p>
        <p>ULTM8 is built on eight pillars, four for vitality (health) and four for freedom (wealth). Each one is a key risk factor for your healthspan or wealthspan. ULTM8 helps you see where you stand and strengthen the pillars that need it most.</p>
      </div>
      <div class="pillar-groups">
${group("Vitality", "The physical capacity to stay active, capable and independent.", [
  ["Heart health", "Your cardiovascular foundations."],
  ["Strength", "The power to lift, carry and stay physically capable."],
  ["Stamina", "The endurance to stay active and recover well."],
  ["Lifestyle", "The daily patterns underneath everything else."],
])}
${group("Freedom", "The financial resilience and choices that help you shape your life.", [
  ["Debt", "What you owe, and what it costs you."],
  ["Protection", "The buffer that keeps a setback from becoming a crisis."],
  ["Retirement", "The horizon your savings need to reach."],
  ["Income", "What funds today and creates tomorrow's choices."],
])}
      </div>
      <a class="detail-link" href="https://ultm8life.com" target="_blank" rel="noopener">ultm8life.com &rarr;</a>
    </article>`;

  return layout({
    title: `ULTM8 — ${SITE.name}`,
    description:
      "ULTM8 helps you add more life to your years by applying Risk Thinking to eight pillars of healthspan and wealthspan.",
    body,
    active: "ultm8",
    wide: true,
  });
}

// ---- Build ------------------------------------------------------------------

async function readPostsFor(blog) {
  const dir = path.join(POSTS_DIR, blog.slug);
  let files = [];
  try {
    files = (await readdir(dir)).filter((f) => /\.html?$/i.test(f));
  } catch {
    return [];
  }

  const posts = [];
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const raw = stripComments(await readFile(fullPath, "utf8"));
    const fileStat = await stat(fullPath);

    const title =
      getMeta(raw, "title") ||
      getTitleTag(raw) ||
      getFirstH1(raw) ||
      slugify(file).replace(/-/g, " ");

    const date = getMeta(raw, "date") || fileStat.mtime.toISOString().slice(0, 10);

    const tags = (getMeta(raw, "tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const description = getMeta(raw, "description") || getFirstParagraph(raw) || "";
    const pinned = (getMeta(raw, "pinned") || "").toLowerCase() === "true";
    const category = getMeta(raw, "category") || "";

    posts.push({
      slug: slugify(file),
      blogSlug: blog.slug,
      title,
      date,
      tags,
      category,
      description,
      // Working papers open with a subtitle + byline block, so an auto-excerpt
      // scrapes that chrome. Use their authored description as the card summary.
      excerpt:
        blog.section === "working-papers"
          ? description
          : makeExcerpt(getBody(raw)),
      pinned,
      body: getBody(raw).trim(),
    });
  }

  // Newest first.
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Curated sections run in a fixed category order, not by date.
  if (blog.order) {
    posts.sort(
      (a, b) => blog.order.indexOf(a.category) - blog.order.indexOf(b.category)
    );
  }

  // Number the Notes as a series: oldest is No. 1, newest the highest.
  // Posts are date-sorted newest first, so index 0 gets the top number.
  if (blog.section === "posts") {
    const n = posts.length;
    posts.forEach((p, i) => {
      p.number = n - i;
    });
  }

  return posts;
}

async function build() {
  // Fresh dist/.
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  // Pick up a personal photo for the About page if one is dropped in src/.
  // Drop a file named terence.jpg (or .jpeg/.png/.webp) into blog/src/.
  const photoNames = ["terence.jpg", "terence.jpeg", "terence.png", "terence.webp"];
  for (const name of photoNames) {
    try {
      await stat(path.join(ROOT, "src", name));
      await copyFile(path.join(ROOT, "src", name), path.join(DIST_DIR, name));
      SITE.photo = "/" + name;
      break;
    } catch {}
  }

  let total = 0;
  for (const blog of BLOGS) {
    blog.posts = await readPostsFor(blog);
    await mkdir(path.join(DIST_DIR, blog.slug), { recursive: true });

    for (const post of blog.posts) {
      await writeFile(
        path.join(DIST_DIR, blog.slug, `${post.slug}.html`),
        postPage(post, blog),
        "utf8"
      );
    }
    await writeFile(
      path.join(DIST_DIR, blog.slug, "index.html"),
      sectionIndexPage(blog),
      "utf8"
    );
    total += blog.posts.length;
  }

  // Home + About + stylesheet.
  await writeFile(path.join(DIST_DIR, "index.html"), homePage(), "utf8");
  await mkdir(path.join(DIST_DIR, "about"), { recursive: true });
  await writeFile(path.join(DIST_DIR, "about", "index.html"), aboutPage(), "utf8");
  await mkdir(path.join(DIST_DIR, "work"), { recursive: true });
  await writeFile(path.join(DIST_DIR, "work", "index.html"), workPage(), "utf8");
  await mkdir(path.join(DIST_DIR, "ultm8"), { recursive: true });
  await writeFile(path.join(DIST_DIR, "ultm8", "index.html"), ultm8Page(), "utf8");
  await mkdir(path.join(DIST_DIR, "ovana"), { recursive: true });
  await writeFile(path.join(DIST_DIR, "ovana", "index.html"), ovanaPage(), "utf8");
  await copyFile(STYLES_SRC, path.join(DIST_DIR, "styles.css"));

  console.log(`Built ${total} post${total === 1 ? "" : "s"} across ${BLOGS.length} folders -> ${path.relative(ROOT, DIST_DIR)}/`);
  for (const blog of BLOGS) {
    console.log(`  ${blog.name} (${blog.posts.length})`);
    for (const p of blog.posts) console.log(`    - ${p.date}  ${p.title}`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
