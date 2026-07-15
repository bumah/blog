// Static blog generator.
// Reads every .html file in posts/, extracts metadata from the HTML itself,
// wraps each post's body in a shared theme, and writes a static site to dist/.
//
// Per-post metadata is read (in order of preference) from:
//   title       -> <meta name="title">, else <title>, else first <h1>, else filename
//   date        -> <meta name="date" content="YYYY-MM-DD">, else file modified time
//   tags        -> <meta name="tags" content="foo, bar">
//   description -> <meta name="description">, else first <p>, else ""
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
  // Shown small in the corner of every page (your wordmark / nav-home link).
  title: "Terence Bumah",
  // The big hero intro on the homepage. Make this personal — it's your front door.
  heroHeading: "Thinking in the *open*",
  // Used for the <meta name=\"description\"> SEO tag.
  description: "Personal reflections on life, work, and figuring things out.",
  author: "Terence Bumah",
  // Contact / social links shown in the footer of every page.
  // Edit the URLs below; delete any line you don't want to show.
  links: [
    { label: "Email", href: "mailto:contact@terencebumah.com" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/terencebumah" },
    { label: "Substack", href: "https://bumah.substack.com" },
  ],
};

// Topic sections, shown in this order on the homepage. Each post picks one via
// <meta name="category" content="Failure First">. A post with no (or an unknown)
// category falls into DEFAULT_CATEGORY. Empty sections are hidden automatically.
const CATEGORIES = [
  { name: "Failure First", blurb: "Assume the goal already failed \u2014 then work backwards to prevent it." },
  { name: "One to Zero", blurb: "Reverse-engineering why startups won, from launch back to origin, through my SOURCE lens." },
  { name: "Longevity", blurb: "On living long \u2014 and living well." },
  { name: "Notes", blurb: "Random thoughts, opinions, and things worth sharing." },
];
const DEFAULT_CATEGORY = "Notes";

// ---- Tiny HTML helpers ------------------------------------------------------

// Escape text destined for HTML attribute/text contexts.
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strip tags to get plain text (used for excerpts).
function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
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

// ---- Page templates ---------------------------------------------------------

function layout({ title, description, body, home = false }) {
  const header = home
    ? `<header class="site-hero">
    <p class="hero-eyebrow"><a href="/">${escapeHtml(SITE.title)}</a></p>
    <h1 class="hero-heading">${escapeHtml(SITE.heroHeading).replace(/\*([^*]+)\*/g, "<em>$1</em>")}</h1>
  </header>`
    : `<header class="site-header">
    <a class="site-title" href="/">${escapeHtml(SITE.title)}</a>
  </header>`;
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
  ${header}
  <main class="container${home ? " container-home" : ""}">
${body}
  </main>
  <footer class="site-footer${home ? " site-footer-home" : ""}">
    ${
      SITE.links && SITE.links.length
        ? `<nav class="contact-links">${SITE.links
            .map(
              (l) =>
                `<a href="${escapeHtml(l.href)}">${escapeHtml(l.label)}</a>`
            )
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

function postPage(post) {
  const tags = post.tags.length
    ? `<ul class="tag-list">${post.tags
        .map((t) => `<li class="tag">${escapeHtml(t)}</li>`)
        .join("")}</ul>`
    : "";
  const body = `    <article class="post">
      <header class="post-header">
        <h1 class="post-title">${escapeHtml(post.title)}</h1>
        ${tags}
      </header>
      <div class="post-body">
${post.body}
      </div>
      <p class="back"><a href="/">&larr; All posts</a></p>
    </article>`;
  return layout({ title: post.title, description: post.description, body });
}

function feedItem(p) {
  return `        <article class="feed-item">
          <a class="feed-item-link" href="/posts/${escapeHtml(p.slug)}.html">
            <span class="feed-item-cat">${escapeHtml(p.category)}</span>
            <h2 class="feed-item-title">${escapeHtml(p.title)}</h2>
            ${p.excerpt ? `<p class="feed-item-excerpt">${escapeHtml(p.excerpt)}</p>` : ""}
            <span class="feed-item-more">Read<span class="feed-item-arrow">\u2192</span></span>
          </a>
        </article>`;
}

function featuredItem(p) {
  return `          <a class="featured-item" href="/posts/${escapeHtml(p.slug)}.html">
            <h4 class="featured-item-title">${escapeHtml(p.title)}</h4>
            ${p.description ? `<p class="featured-item-excerpt">${escapeHtml(p.description)}</p>` : ""}
          </a>`;
}

function indexPage(posts) {
  const featured = posts.filter((p) => p.pinned);
  const feed = posts.filter((p) => !p.pinned);

  if (!posts.length) {
    const body = `    <div class="home-top">
      <div class="feed"><p class="feed-empty">No posts yet. Add an .html file to the posts/ folder.</p></div>
    </div>`;
    return layout({ title: SITE.title, description: SITE.description, body, home: true });
  }

  const rail = featured.length
    ? `      <aside class="featured-rail">
        <h2 class="rail-label">Featured</h2>
        <div class="featured-list">
${featured.map(featuredItem).join("\n")}
        </div>
      </aside>`
    : "";

  const feedHtml = feed.length
    ? feed.map(feedItem).join("\n")
    : `        <p class="feed-empty">More posts coming soon.</p>`;

  const body = `    <div class="home-top">
      <div class="feed">
${feedHtml}
      </div>
${rail}
    </div>`;

  return layout({ title: SITE.title, description: SITE.description, body, home: true });
}

// ---- Build ------------------------------------------------------------------

async function build() {
  // Fresh dist/.
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(path.join(DIST_DIR, "posts"), { recursive: true });

  let files = [];
  try {
    files = (await readdir(POSTS_DIR)).filter((f) => /\.html?$/i.test(f));
  } catch {
    console.error(`No posts/ directory found at ${POSTS_DIR}`);
  }

  const posts = [];
  for (const file of files) {
    const fullPath = path.join(POSTS_DIR, file);
    const raw = stripComments(await readFile(fullPath, "utf8"));
    const fileStat = await stat(fullPath);

    const title =
      getMeta(raw, "title") ||
      getTitleTag(raw) ||
      getFirstH1(raw) ||
      slugify(file).replace(/-/g, " ");

    const date =
      getMeta(raw, "date") || fileStat.mtime.toISOString().slice(0, 10);

    const tags = (getMeta(raw, "tags") || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const description =
      getMeta(raw, "description") || getFirstParagraph(raw) || "";

    const pinned = (getMeta(raw, "pinned") || "").toLowerCase() === "true";

    const rawCategory = getMeta(raw, "category") || "";
    const matchedCategory = CATEGORIES.find(
      (c) => c.name.toLowerCase() === rawCategory.toLowerCase()
    );
    const category = matchedCategory ? matchedCategory.name : DEFAULT_CATEGORY;

    posts.push({
      slug: slugify(file),
      title,
      date,
      tags,
      description,
      excerpt: makeExcerpt(getBody(raw)),
      pinned,
      category,
      body: getBody(raw).trim(),
    });
  }

  // Pinned posts first, then newest first within each group.
  posts.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });

  // Write each post page.
  for (const post of posts) {
    await writeFile(
      path.join(DIST_DIR, "posts", `${post.slug}.html`),
      postPage(post),
      "utf8"
    );
  }

  // Write index and copy stylesheet.
  await writeFile(path.join(DIST_DIR, "index.html"), indexPage(posts), "utf8");
  await copyFile(STYLES_SRC, path.join(DIST_DIR, "styles.css"));

  console.log(
    `Built ${posts.length} post${posts.length === 1 ? "" : "s"} -> ${path.relative(
      ROOT,
      DIST_DIR
    )}/`
  );
  for (const p of posts) console.log(`  - ${p.date}  ${p.title}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
