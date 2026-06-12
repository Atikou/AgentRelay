const testFeed = document.getElementById("test-feed");

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

function addStandaloneMessage(_role, content) {
  testFeed.innerHTML = "";
  const box = document.createElement("div");
  box.className = "history-empty is-error";
  if (content instanceof Node) box.appendChild(content);
  else box.textContent = content;
  testFeed.appendChild(box);
  return box;
}

async function initTestCasesPage() {
  if (typeof window.openTestCasesPanel !== "function") {
    addStandaloneMessage("system", "测试用例运行器未加载，请刷新页面。");
    return;
  }
  await window.openTestCasesPanel({
    feed: testFeed,
    clearWelcome: () => {},
    addMessage: addStandaloneMessage,
    escapeHtml,
  });
}

void initTestCasesPage();
