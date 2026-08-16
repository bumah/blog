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
  // Wordmark shown top-left in the nav on every page (links home).
  name: "Risk Thinking",
  // The big hero on the home page. Use *stars* to accent a word.
  homeHeading: "Risk *Thinking*",
  // One line under the home hero.
  subtext: "Think like a risk officer. Twenty years of managing risk, applied to real life.",
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
    name: "Notes",
    section: "posts",
    heroHeading: "*Notes*.",
    description:
      "Short notes on the risks of everyday life, and how to stay ahead of them, by Terence Bumah.",
  },
  {
    slug: "working-papers",
    name: "Working Papers",
    section: "working-papers",
    heroHeading: "Working *Papers*",
    description:
      "Longer-form risk frameworks for enterprises, longevity and startups, by Terence Bumah.",
    order: ["Enterprises", "AI", "Longevity", "Startups"],
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
    <a class="nav-brand" href="/">${escapeHtml(SITE.name)}</a>
    <div class="nav-links">${item("Notes", "/", "notes")}${item("Working Papers", "/working-papers/", "working-papers")}${item("About", "/about/", "about")}</div>
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

// One item in a stream. `showCat` falls back to the section name when a post
// has no category label of its own.
function streamItem(p, showCat) {
  // Curated posts carry a category label (a risk domain or a survival setting);
  // otherwise fall back to the section name when asked.
  const label = p.category || (showCat ? p.blogName : "");
  return `        <article class="feed-item" data-topic="${escapeHtml(p.blogSlug)}">
          <a class="feed-item-link" href="/${p.blogSlug}/${escapeHtml(p.slug)}.html">
            ${label ? `<span class="feed-item-cat">${escapeHtml(label)}</span>` : ""}
            <h2 class="feed-item-title">${escapeHtml(p.title)}</h2>
            ${p.excerpt ? `<p class="feed-item-excerpt">${escapeHtml(p.excerpt)}</p>` : ""}
            ${p.date ? `<span class="feed-item-date">${escapeHtml(fmtDate(p.date))}</span>` : ""}
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
      ? "All notes"
      : blog.slug === "working-papers"
      ? "All working papers"
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
  const feedHtml = blog.posts.length
    ? blog.posts.map((p) => streamItem(p, false)).join("\n")
    : `        <p class="feed-empty">More coming soon.</p>`;
  const body = `    <section class="home-feed">
      <div class="feed">
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
  const heroHtml = `  <header class="site-hero">
    <h1 class="hero-heading">Why think like a risk officer</h1>
  </header>`;

  const body = `    <article class="post about-page">
      <div class="post-body">
        <p>Success starts with not failing. That is what thinking like a risk officer helps you do in everyday life.</p>
        <p>The approach is simple. I look at the different ways things can go wrong, then share simple frameworks you can apply to improve your odds. Nothing in life is guaranteed. It is all about improving your chances of success by reducing your chances of failure.</p>
        <p>This is not about avoiding risk. The goal is to take the right risks with clear eyes, not to dodge every risk you meet. Across health, money, business and personal growth, the method stays the same: see what could go wrong, weigh it, and make the smarter move.</p>
        <p>Every post here names a risk worth navigating and gives you a way to stay ahead of it.</p>
        <h2>About me</h2>
        <p>I am Terence Bumah. I spent 20 years managing risk in financial services, where my job was to see what could go wrong before it did, and to help take the right risks anyway.</p>
        <p>Risk Thinking is me turning that same discipline on everyday life. The frameworks that protect banks turn out to be just as useful for protecting your health, your money, your work, and the choices that shape how well you live.</p>
      </div>
    </article>`;

  return layout({
    title: `About — ${SITE.name}`,
    description:
      "Why Terence Bumah thinks like a risk officer, and how 20 years managing risk in financial services shapes Risk Thinking.",
    body,
    active: "about",
    heroHtml,
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

  return posts;
}

async function build() {
  // Fresh dist/.
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

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
