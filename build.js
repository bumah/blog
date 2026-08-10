// Static site generator for a personal notebook.
// Each post lives in posts/<topic-slug>/ as a folder of .html files. Metadata is
// read from the HTML itself. The generator writes:
//   /                        -> home: one stream of all Posts + topic filters
//   /<topic-slug>/           -> that topic's stream (a filtered view)
//   /publications/           -> the Publications section
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
  name: "TTB",
  // The big hero on the home page. Use *stars* to accent a word.
  homeHeading: "Things I'm *thinking about*\u2026",
  // Used for the <meta name="description"> SEO tag on the home page.
  description:
    "Terence Bumah \u2014 things I'm thinking about. Notes on health, money, entrepreneurship, and life after 40.",
  author: "Terence Bumah",
  // Contact / social links shown in the footer of every page.
  links: [
    { label: "Email", href: "mailto:contact@terencebumah.com" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/terencebumah" },
    { label: "Substack", href: "https://bumah.substack.com" },
  ],
};

// Two sections: "posts" (the mixed stream, filterable by topic) and
// "publications" (longer-form frameworks, kept separate). Topics are the folders
// under posts/ whose section is "posts"; they become the filter chips.
const BLOGS = [
  {
    slug: "health",
    name: "Health",
    section: "posts",
    heroHeading: "*Health*.",
    description:
      "Longevity, fitness, and health \u2014 what I'm learning about staying strong after 40.",
  },
  {
    slug: "money",
    name: "Money",
    section: "posts",
    heroHeading: "*Money*.",
    description:
      "Investing, retirement, and building financial freedom after 40.",
  },
  {
    slug: "entrepreneurship",
    name: "Entrepreneurship",
    section: "posts",
    heroHeading: "*Entrepreneurship*.",
    description:
      "Startup teardowns, product frameworks, and building my own ventures in the open.",
  },
  {
    slug: "personal-growth",
    name: "Personal Growth",
    section: "posts",
    heroHeading: "*Growth*.",
    description:
      "Mindsets and personal systems for getting better with age.",
  },
  {
    slug: "publications",
    name: "Publications",
    section: "publications",
    heroHeading: "Risk Publications",
    description:
      "Risk frameworks for enterprises, longevity and startups, by Terence Bumah.",
  },
];

const TOPICS = BLOGS.filter((b) => b.section === "posts");

// Fixed running order for the publications section (overrides date sort).
const CATEGORY_ORDER = ["Enterprises", "Longevity", "Startups"];

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

// Top navigation. `active` is a section key: "posts" or "publications".
function nav(active) {
  const item = (name, href, key) =>
    `<a class="nav-link${active === key ? " is-active" : ""}" href="${href}">${escapeHtml(name)}</a>`;
  return `  <nav class="site-nav">
    <a class="nav-brand" href="/">${escapeHtml(SITE.name)}</a>
    <div class="nav-links">${item("Posts", "/", "posts")}${item("Publications", "/publications/", "publications")}</div>
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

// Topic filter chips. `activeTopic` is a topic slug, or "all" on the home page.
// The chips are real links (each topic has its own page), so they work without
// JavaScript; on the home page a small script filters the stream in place.
function chipRow(activeTopic) {
  const chip = (slug, name, href) =>
    `<a class="chip${activeTopic === slug ? " is-active" : ""}" href="${href}" data-topic="${slug}">${escapeHtml(name)}</a>`;
  return `      <nav class="chip-row">
        ${chip("all", "All", "/")}
        ${TOPICS.map((t) => chip(t.slug, t.name, `/${t.slug}/`)).join("\n        ")}
      </nav>`;
}

// One item in a stream. `showCat` adds the topic label (used on the home page,
// where posts from every topic are mixed together).
function streamItem(p, showCat) {
  // Publications carry a domain label (Enterprises/Longevity/Startups); the
  // mixed home feed shows the topic name instead.
  const label =
    p.blogSlug === "publications" ? p.category : showCat ? p.blogName : "";
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
  const isPub = blog.section === "publications";
  const tags = post.tags.length
    ? `<ul class="tag-list">${post.tags
        .map((t) => `<li class="tag">${escapeHtml(t)}</li>`)
        .join("")}</ul>`
    : "";
  const backHref = isPub ? "/publications/" : `/${blog.slug}/`;
  const backText = isPub ? "All publications" : `All ${blog.name} posts`;
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
    active: isPub ? "publications" : "posts",
  });
}

// A topic page: hero + chips (this topic active) + that topic's stream.
function topicIndexPage(blog) {
  const feedHtml = blog.posts.length
    ? blog.posts.map((p) => streamItem(p, false)).join("\n")
    : `        <p class="feed-empty">More posts coming soon.</p>`;
  const body = `    <section class="home-feed">
${chipRow(blog.slug)}
      <div class="feed">
${feedHtml}
      </div>
    </section>`;
  return layout({
    title: `${blog.name} — ${SITE.name}`,
    description: blog.description,
    body,
    active: "posts",
    heroHtml: blogHero(blog),
    wide: true,
  });
}

// The Publications section: hero + a single stream (no topic chips).
function publicationsIndexPage(blog) {
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
    active: "publications",
    heroHtml: blogHero(blog),
    wide: true,
  });
}

const FILTER_SCRIPT = `    <script>
    (function () {
      var row = document.querySelector('.chip-row');
      if (!row) return;
      var chips = row.querySelectorAll('.chip');
      var items = document.querySelectorAll('.feed-item');
      row.addEventListener('click', function (e) {
        var chip = e.target.closest('.chip');
        if (!chip || !row.contains(chip)) return;
        e.preventDefault();
        var topic = chip.getAttribute('data-topic');
        chips.forEach(function (c) { c.classList.toggle('is-active', c === chip); });
        items.forEach(function (it) {
          var show = topic === 'all' || it.getAttribute('data-topic') === topic;
          it.style.display = show ? '' : 'none';
        });
      });
    })();
    </script>`;

function homePage() {
  const heroHtml = `  <header class="site-hero">
    <h1 class="hero-heading">${accent(SITE.homeHeading)}</h1>
  </header>`;

  // Everything in the "posts" section, mixed together, newest first.
  const stream = TOPICS.flatMap((b) =>
    b.posts.map((p) => ({ ...p, blogName: b.name }))
  ).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const body = `    <section class="home-feed">
${chipRow("all")}
      <div class="feed">
${stream.map((p) => streamItem(p, true)).join("\n")}
      </div>
    </section>
${FILTER_SCRIPT}`;

  return layout({
    title: `${SITE.name} — ${SITE.author}`,
    description: SITE.description,
    body,
    active: "posts",
    heroHtml,
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
      // Publications open with a subtitle + byline block, so an auto-excerpt
      // scrapes that chrome. Use their authored description as the card summary.
      excerpt:
        blog.section === "publications"
          ? description
          : makeExcerpt(getBody(raw)),
      pinned,
      body: getBody(raw).trim(),
    });
  }

  // Newest first.
  posts.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  // Publications run in a fixed domain order, not by date.
  if (blog.section === "publications") {
    posts.sort(
      (a, b) =>
        CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category)
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
      blog.section === "publications"
        ? publicationsIndexPage(blog)
        : topicIndexPage(blog),
      "utf8"
    );
    total += blog.posts.length;
  }

  // Home + stylesheet.
  await writeFile(path.join(DIST_DIR, "index.html"), homePage(), "utf8");
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
