import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildApp } from "../src/app.js";
import type { Database } from "../src/database.js";

/** 作用：为鉴权测试提供受控数据库；入参：项目角色或空值；返回：只处理身份和权限查询的数据库替身。 */
function databaseFor(role: string | null): Database {
  return {
    /** 作用：结束测试数据库替身；入参：无；返回：已完成 Promise。 */
    async close() {},
    pool: {
      /** 作用：模拟身份与成员查询；入参：SQL；返回：受控用户或成员行。 */
      async query(sql: string) {
        if (sql.includes("FROM sessions"))
          return {
            rows: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                email: "reader@example.com",
                display_name: "Reader",
                role: "user",
              },
            ],
            rowCount: 1,
          };
        if (sql.includes("FROM project_members"))
          return { rows: role ? [{ role }] : [], rowCount: role ? 1 : 0 };
        throw new Error("测试不允许访问其他查询");
      },
    },
  } as unknown as Database;
}

const config = {
  databaseUrl: "postgresql://example",
  secret: "test-secret-that-is-at-least-32-characters",
  adminEmail: "admin@example.com",
  adminPassword: "test-admin-password",
  port: 8080,
};
const url = "/api/projects/22222222-2222-4222-8222-222222222222/quality/jobs";

/** 作用：验证未登录无法读取历史；入参：测试上下文；返回：断言完成。 */
test("质量分析历史要求登录", async () => {
  const app = await buildApp(config, databaseFor("viewer"));
  try {
    const result = await app.inject({ method: "GET", url });
    assert.equal(result.statusCode, 401);
  } finally {
    await app.close();
  }
});

/** 作用：验证只读角色不能上传，不能访问其他项目；入参：无；返回：断言完成。 */
test("质量任务继承项目只读与隔离权限", async () => {
  const viewer = await buildApp(config, databaseFor("viewer"));
  const outsider = await buildApp(config, databaseFor(null));
  try {
    const upload = await viewer.inject({
      method: "POST",
      url,
      headers: {
        authorization: "Bearer test-session",
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("trace"),
    });
    assert.equal(upload.statusCode, 403);
    const read = await outsider.inject({
      method: "GET",
      url,
      headers: { authorization: "Bearer test-session" },
    });
    assert.equal(read.statusCode, 403);
  } finally {
    await viewer.close();
    await outsider.close();
  }
});
