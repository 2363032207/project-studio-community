/** 作用：在隔离无头浏览器中检查质量工作台；入参：测试账号、Playwright 模块和浏览器环境变量；返回：退出状态和本地截图。 */
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const moduleName = process.env.QUALITY_PLAYWRIGHT_MODULE;
const { chromium } = await import(
  moduleName ? pathToFileURL(resolve(moduleName)).href : "playwright"
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.QUALITY_BROWSER_PATH,
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await context.newPage();
const errors = [];
// 作用：记录渲染异常；入参：页面错误；返回：错误入列表。
page.on("pageerror", (error) => errors.push(error.message));
try {
  const login = await context.request.post(
    "http://127.0.0.1:8088/api/auth/login",
    {
      data: {
        email: process.env.QUALITY_TEST_EMAIL,
        password: process.env.QUALITY_TEST_PASSWORD,
      },
    },
  );
  assert.equal(login.status(), 200, "本地演示账号登录");
  const { token } = await login.json();
  // 作用：向隔离浏览器注入本地会话；入参：本次测试令牌；返回：无，不读写用户浏览器配置。
  await context.addInitScript(
    (value) => localStorage.setItem("project-studio-token", value),
    token,
  );
  await page.goto("http://127.0.0.1:8088/#performance");
  await page
    .getByRole("heading", { name: "性能监控分析", exact: true })
    .waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "performance-baseline.csv" })
    .first()
    .getByRole("button", { name: "查看报告" })
    .click();
  await page.getByRole("heading", { name: "风险与优化建议" }).waitFor();
  assert.ok((await page.getByRole("img").count()) >= 4, "性能趋势图");
  await mkdir("data/ui-smoke", { recursive: true });
  await page.screenshot({
    path: "data/ui-smoke/performance.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: /分析历史/ }).click();
  await page.getByRole("checkbox").nth(0).check();
  await page.getByRole("checkbox").nth(1).check();
  await page.getByRole("button", { name: /对比所选/ }).click();
  await page.getByRole("button", { name: "多文件对比", exact: true }).waitFor();
  await page.getByRole("img").first().waitFor();
  await page.getByRole("button", { name: "＋ 导入性能数据" }).click();
  await page.getByRole("dialog").waitFor();
  const input = page.getByRole("dialog").locator("input[type=file]");
  await input.setInputFiles(resolve("data/samples/performance-candidate.csv"));
  await page.getByRole("button", { name: "上传并分析", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.goto("http://127.0.0.1:8088/#apk");
  await page
    .getByRole("heading", { name: "APK 包体自检", exact: true })
    .waitFor();
  await page
    .getByRole("row")
    .filter({ hasText: "demo-game.apk" })
    .first()
    .getByRole("button", { name: "查看报告" })
    .click();
  await page.getByRole("heading", { name: "包体分类占比" }).waitFor();
  await page.getByRole("button", { name: "重复内容", exact: true }).click();
  await page.getByText("完全重复的路径", { exact: true }).waitFor();
  await page.screenshot({ path: "data/ui-smoke/apk.png", fullPage: true });
  await page.getByRole("button", { name: "质量红线", exact: true }).click();
  await page.getByRole("heading", { name: "项目质量红线" }).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    "PASS: 两个模块渲染、图表、报告、对比、真实 UI 上传、重复资源、规则页；无页面异常。",
  );
  console.log(
    "Screenshots: data/ui-smoke/performance.png, data/ui-smoke/apk.png",
  );
} catch (error) {
  await page.screenshot({ path: "data/ui-smoke/error.png", fullPage: true });
  console.error((await page.locator("main").innerText()).slice(-6000));
  throw error;
} finally {
  await browser.close();
}
