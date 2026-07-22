// Static site generator for a multi-blog publication.
// Each blog lives in posts/<blog-slug>/ as a folder of .html files. Metadata is
// read from the HTML itself. The generator writes:
//   /                       -> home (intros both blogs + recent posts from each)
//   /<blog-slug>/           -> that blog's index (feed + featured rail)
//   /<blog-slug>/<slug>.html-> a single post
//
// Per-post metadata is read (in order of preference) from:
//   title       -> <meta name="title">, else <title>, else first <h1>, else filename
//   date        -> <meta name="date" content="YYYY-MM-DD">, else file modified time
//   description -> <meta name="description">, else first <p>, else ""
//   pinned      -> <meta name="pinned" content="true">  (surfaces in Featured)
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
  homeHeading: "Figuring things out, in the *open*.",
  homeSubtext:
    "Sharing my research, experiments, and lessons on innovation, health, money — and whatever else sparks my curiosity.",
  // Used for the <meta name="description"> SEO tag on the home page.
  description:
    "Terence Bumah — writing in the open about longevity, and about why the world's best products and startups win.",
  author: "Terence Bumah",
  // Contact / social links shown in the footer of every page.
  links: [
    { label: "Email", href: "mailto:contact@terencebumah.com" },
    { label: "LinkedIn", href: "https://www.linkedin.com/in/terencebumah" },
    { label: "Substack", href: "https://bumah.substack.com" },
  ],
};

// The blogs, shown in this order in the nav and on the home page. Each blog is a
// folder under posts/ named after its `slug`.
const BLOGS = [
  {
    slug: "the-long-run",
    name: "The Long Run",
    heroHeading: "The Long *Run*",
    heroSubtext:
      "Longevity isn't just about living longer — it's about living well, longer. Sharing my experiments and everything I learn about building my health and wealth for the long run.",
    description:
      "Documenting my longevity journey — health and wealth — and what I'm learning along the way.",
    tagline:
      "Documenting how I build my health and wealth for the long run — longevity, in the open.",
  },
  {
    slug: "one-to-zero",
    name: "One to Zero",
    heroHeading: "One to *Zero*",
    heroSubtext:
      "Reverse-engineering the success of the world's best products and startups — working back from what they became to the decisions that got them there.",
    description:
      "Reverse-engineering the success of the world's best products and startups.",
    tagline:
      "Reverse-engineering the success of the world's best products and startups.",
  },
  {
    slug: "lifes-a-beach",
    name: "Life's a Beach",
    heroHeading: "Life's a *Beach*",
    heroSubtext:
      "Life can be rough, life can be calm. Building the systems to enjoy and ride the waves.",
    description:
      "Personal systems for living easier, clearer, and more enjoyably.",
    tagline:
      "Personal systems for an easier, clearer, more enjoyable life.",
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

// Top navigation. `active` is a blog slug, or "home" for the home page.
function nav(active) {
  const links = BLOGS.map(
    (b) =>
      `<a class="nav-link${b.slug === active ? " is-active" : ""}" href="/${b.slug}/">${escapeHtml(b.name)}</a>`
  ).join("");
  return `  <nav class="site-nav">
    <a class="nav-brand${active === "home" ? " is-active" : ""}" href="/">${escapeHtml(SITE.name)}</a>
    <div class="nav-links">${links}</div>
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
    ${blog.heroSubtext ? `<p class="hero-text">${escapeHtml(blog.heroSubtext)}</p>` : ""}
  </header>`;
}

function postPage(post, blog) {
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
      <p class="back"><a href="/${blog.slug}/">&larr; All ${escapeHtml(blog.name)} posts</a></p>
    </article>`;
  return layout({
    title: post.title,
    description: post.description,
    body,
    active: blog.slug,
  });
}

function feedItem(p) {
  return `        <article class="feed-item">
          <a class="feed-item-link" href="/${p.blogSlug}/${escapeHtml(p.slug)}.html">
            <h2 class="feed-item-title">${escapeHtml(p.title)}</h2>
            ${p.excerpt ? `<p class="feed-item-excerpt">${escapeHtml(p.excerpt)}</p>` : ""}
            <span class="feed-item-more">Read<span class="feed-item-arrow">\u2192</span></span>
          </a>
        </article>`;
}

function featuredItem(p) {
  return `          <a class="featured-item" href="/${p.blogSlug}/${escapeHtml(p.slug)}.html">
            <h4 class="featured-item-title">${escapeHtml(p.title)}</h4>
            ${p.description ? `<p class="featured-item-excerpt">${escapeHtml(p.description)}</p>` : ""}
          </a>`;
}

function blogIndexPage(blog) {
  const posts = blog.posts;
  const featured = posts.filter((p) => p.pinned);
  const feed = posts.filter((p) => !p.pinned);

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

  return layout({
    title: `${blog.name} — ${SITE.name}`,
    description: blog.description,
    body,
    active: blog.slug,
    heroHtml: blogHero(blog),
    wide: true,
  });
}

function blogCard(blog) {
  const count = blog.posts.length;
  return `      <a class="blog-card" href="/${blog.slug}/">
        <h2 class="blog-card-name">${escapeHtml(blog.name)}</h2>
        <p class="blog-card-tagline">${escapeHtml(blog.tagline)}</p>
        <span class="blog-card-cta">Explore ${escapeHtml(blog.name)}<span class="blog-card-arrow">\u2192</span></span>
      </a>`;
}

function recentItem(p) {
  return `          <a class="recent-item" href="/${p.blogSlug}/${escapeHtml(p.slug)}.html">
            ${p.date ? `<span class="recent-date">${escapeHtml(fmtDate(p.date))}</span>` : ""}
            <h4 class="recent-title">${escapeHtml(p.title)}</h4>
          </a>`;
}

function recentsColumn(blog) {
  const recent = [...blog.posts]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 3);
  const items = recent.length
    ? recent.map(recentItem).join("\n")
    : `          <p class="feed-empty">Posts coming soon.</p>`;
  return `      <div class="recents-col">
        <h3 class="recents-label">Latest from ${escapeHtml(blog.name)}</h3>
        <div class="recents-list">
${items}
        </div>
        <a class="recents-more" href="/${blog.slug}/">All ${escapeHtml(blog.name)} posts \u2192</a>
      </div>`;
}

function homePage() {
  const heroHtml = `  <header class="site-hero">
    <h1 class="hero-heading">${accent(SITE.homeHeading)}</h1>
    ${SITE.homeSubtext ? `<p class="hero-text">${escapeHtml(SITE.homeSubtext)}</p>` : ""}
  </header>`;

  const cards = `    <section class="blog-cards">
${BLOGS.map(blogCard).join("\n")}
    </section>`;

  const recents = `    <section class="home-recents">
${BLOGS.map(recentsColumn).join("\n")}
    </section>`;

  const body = `${cards}
${recents}`;

  return layout({
    title: `${SITE.name} — ${SITE.author}`,
    description: SITE.description,
    body,
    active: "home",
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

    posts.push({
      slug: slugify(file),
      blogSlug: blog.slug,
      title,
      date,
      tags,
      description,
      excerpt: makeExcerpt(getBody(raw)),
      pinned,
      body: getBody(raw).trim(),
    });
  }

  // Pinned posts first, then newest first within each group.
  posts.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
  });

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
      blogIndexPage(blog),
      "utf8"
    );
    total += blog.posts.length;
  }

  // Home + stylesheet.
  await writeFile(path.join(DIST_DIR, "index.html"), homePage(), "utf8");
  await copyFile(STYLES_SRC, path.join(DIST_DIR, "styles.css"));

  console.log(`Built ${total} post${total === 1 ? "" : "s"} across ${BLOGS.length} blogs -> ${path.relative(ROOT, DIST_DIR)}/`);
  for (const blog of BLOGS) {
    console.log(`  ${blog.name} (${blog.posts.length})`);
    for (const p of blog.posts) console.log(`    - ${p.date}  ${p.title}`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
