const docListEl = document.getElementById("doc-list");
const tocListEl = document.getElementById("toc-list");
const contentEl = document.getElementById("doc-content");
const searchEl = document.getElementById("search");

let docs = [];

const prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({
  startOnLoad: false,
  theme: prefersDark ? "dark" : "default",
  securityLevel: "loose",
});
marked.setOptions({ gfm: true, breaks: false });

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败：${res.status}`);
  return data;
}

function renderNav(filter = "") {
  const f = filter.trim().toLowerCase();
  docListEl.innerHTML = "";
  const current = decodeURIComponent(location.hash.replace(/^#\//, ""));
  for (const d of docs) {
    if (f && !d.title.toLowerCase().includes(f) && !d.slug.toLowerCase().includes(f)) continue;
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#/${encodeURIComponent(d.slug)}`;
    a.textContent = d.title;
    if (d.slug === current) a.classList.add("active");
    li.appendChild(a);
    docListEl.appendChild(li);
  }
}

function slugify(text, index) {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${base || "section"}-${index}`;
}

function enhanceContent() {
  // Mermaid：把 ```mermaid 代码块转换为 .mermaid 容器。
  contentEl.querySelectorAll("code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    const div = document.createElement("div");
    div.className = "mermaid";
    div.textContent = code.textContent;
    pre.replaceWith(div);
  });
  try {
    mermaid.run({ nodes: contentEl.querySelectorAll(".mermaid") });
  } catch (e) {
    /* 忽略图渲染错误 */
  }

  // 代码高亮（排除 mermaid）。
  contentEl.querySelectorAll("pre code:not(.language-mermaid)").forEach((block) => {
    try {
      hljs.highlightElement(block);
    } catch (e) {
      /* ignore */
    }
  });

  // 图片加载失败时显示占位，避免破图。
  contentEl.querySelectorAll("img").forEach((img) => {
    img.addEventListener("error", () => {
      const ph = document.createElement("div");
      ph.className = "img-placeholder";
      ph.textContent = `截图待补充：${img.getAttribute("alt") || img.getAttribute("src")}`;
      img.replaceWith(ph);
    });
  });
}

function buildToc() {
  tocListEl.innerHTML = "";
  const headings = contentEl.querySelectorAll("h2, h3");
  headings.forEach((h, i) => {
    const id = slugify(h.textContent, i);
    h.id = id;
    const a = document.createElement("a");
    a.href = `#${id}`;
    a.textContent = h.textContent;
    a.className = h.tagName === "H3" ? "lvl-3" : "lvl-2";
    a.addEventListener("click", (e) => {
      e.preventDefault();
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
      history.replaceState(null, "", `${location.pathname}${location.hash.split("#")[1] ? "" : ""}`);
    });
    const li = document.createElement("li");
    li.appendChild(a);
    tocListEl.appendChild(li);
  });
  setupScrollSpy(headings);
}

let spyHandler = null;
function setupScrollSpy(headings) {
  if (spyHandler) document.querySelector(".doc-main").removeEventListener("scroll", spyHandler);
  const links = [...tocListEl.querySelectorAll("a")];
  const onScroll = () => {
    let activeIndex = 0;
    headings.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= 90) activeIndex = i;
    });
    links.forEach((l, i) => l.classList.toggle("active", i === activeIndex));
  };
  spyHandler = onScroll;
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
}

async function loadDoc(slug) {
  if (!slug) {
    if (docs.length === 0) {
      contentEl.innerHTML = '<p class="loading">docs/ 下暂无文档。</p>';
      return;
    }
    slug = docs[0].slug;
    location.hash = `#/${encodeURIComponent(slug)}`;
    return;
  }
  contentEl.innerHTML = '<p class="loading">加载中…</p>';
  try {
    const data = await api(`/api/docs/content?slug=${encodeURIComponent(slug)}`);
    contentEl.innerHTML = marked.parse(data.markdown);
    enhanceContent();
    buildToc();
    contentEl.parentElement.scrollTop = 0;
    window.scrollTo(0, 0);
  } catch (err) {
    contentEl.innerHTML = `<p class="loading">加载失败：${String(err.message || err)}</p>`;
  }
  renderNav(searchEl.value);
}

function onHashChange() {
  const slug = decodeURIComponent(location.hash.replace(/^#\//, ""));
  // 仅处理 #/slug 形式；锚点跳转(#id)不重载。
  if (location.hash.startsWith("#/") || location.hash === "") {
    loadDoc(slug);
  }
}

async function init() {
  try {
    docs = await api("/api/docs");
  } catch (err) {
    contentEl.innerHTML = `<p class="loading">无法获取文档列表：${String(err.message || err)}</p>`;
    return;
  }
  renderNav();
  onHashChange();
}

searchEl.addEventListener("input", () => renderNav(searchEl.value));
window.addEventListener("hashchange", onHashChange);

init();
