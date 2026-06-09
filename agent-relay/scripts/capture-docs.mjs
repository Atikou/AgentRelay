/**
 * 用无头浏览器截取测试台真实界面，输出到 docs/assets/，供文档站引用。
 * 运行：npm run docs:screenshots   （需先 npm run serve 启动测试台）
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";

const dir = path.dirname(fileURLToPath(import.meta.url));
const assetsDir = path.resolve(dir, "..", "..", "docs", "assets");
mkdirSync(assetsDir, { recursive: true });

const base = process.env.BASE_URL ?? "http://localhost:18787";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1.5 });

  await page.goto(base, { waitUntil: "networkidle2" });
  await sleep(1200);
  await page.screenshot({ path: path.join(assetsDir, "testbench-main.png") });
  console.log("saved testbench-main.png");

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button[data-action]")].find(
      (b) => b.dataset.action === "check-models",
    );
    btn?.click();
  });
  await sleep(3000);
  await page.screenshot({ path: path.join(assetsDir, "testbench-models.png") });
  console.log("saved testbench-models.png");
} finally {
  await browser.close();
}
console.log("截图已输出到:", assetsDir);
