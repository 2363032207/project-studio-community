import type { FastifyInstance, FastifyRequest } from "fastify";
import { Transform, type Readable } from "node:stream";
import { z } from "zod";
import { HttpError } from "./app.js";

type QualityContext = {
  projectRole: (
    request: FastifyRequest,
    projectId: string,
    write?: boolean,
  ) => Promise<string>;
  audit: (
    actorId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    projectId: string | null,
    payload?: object,
  ) => Promise<void>;
};

/** 作用：注册鉴权后的质量分析代理；入参：应用、项目权限上下文；返回：无。 */
export function registerQualityRoutes(
  app: FastifyInstance,
  context: QualityContext,
): void {
  // 保持上传为流，避免将 APK 放入 Fastify JSON 缓冲区。
  app.addContentTypeParser(
    "application/octet-stream",
    (request, payload, done) => {
      done(null, payload);
    },
  );
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/api/projects/:projectId/quality/*",
    bodyLimit: 1024 ** 3,
    /** 作用：校验权限并代理单次请求；入参：HTTP 请求和响应；返回：内部服务结果。 */
    handler: async (request, reply) => {
      const { projectId, "*": resource } = z
        .object({ projectId: z.string().uuid(), "*": z.string().max(200) })
        .parse(request.params);
      const write = request.method !== "GET";
      await context.projectRole(request, projectId, write);
      const allowed =
        (resource === "jobs" && ["GET", "POST"].includes(request.method)) ||
        (resource === "configs" && request.method === "POST") ||
        (resource === "rules" && ["GET", "PUT"].includes(request.method)) ||
        (resource === "compare" && request.method === "GET") ||
        (/^jobs\/[a-f0-9-]{36}$/.test(resource) &&
          ["GET", "DELETE"].includes(request.method)) ||
        (/^jobs\/[a-f0-9-]{36}\/(report|report.html)$/.test(resource) &&
          request.method === "GET");
      if (!allowed) throw new HttpError(404, "NOT_FOUND", "质量接口不存在");
      const headers: Record<string, string> = {
        "X-Quality-Key": process.env.APP_SECRET ?? "",
      };
      let body: string | Readable | undefined;
      if (request.method === "POST" && resource === "jobs") {
        const length = Number(request.headers["content-length"]);
        if (
          request.headers["content-type"] !== "application/octet-stream" ||
          !Number.isSafeInteger(length) ||
          length <= 0 ||
          length > 1024 ** 3
        ) {
          throw new HttpError(
            413,
            "INVALID_UPLOAD",
            "请上传 1 GiB 以内的二进制文件",
          );
        }
        headers["Content-Type"] = "application/octet-stream";
        headers["Content-Length"] = String(length);
        headers["X-Filename"] = String(
          request.headers["x-filename"] ?? "upload.bin",
        );
        headers["X-Analysis-Config"] = z
          .string()
          .uuid()
          .parse(request.headers["x-analysis-config"]);
        let received = 0;
        const limiter = new Transform({
          /** 作用：限制上传流实际字节数；入参：数据块、编码、回调；返回：通过的数据或错误。 */
          transform(chunk: Buffer, encoding, callback) {
            received += chunk.length;
            callback(
              received > length ? new Error("上传长度超限") : null,
              chunk,
            );
          },
        });
        body = (request.body as Readable).pipe(limiter);
      } else if (request.method === "PUT" || request.method === "POST") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(request.body);
        headers["Content-Length"] = String(Buffer.byteLength(body));
      }
      const search = new URL(request.url, "http://local").search;
      const base = process.env.QUALITY_SERVICE_URL ?? "http://127.0.0.1:8090";
      let upstream: Response;
      try {
        const init = {
          method: request.method,
          headers,
          body,
          duplex: "half",
          signal: AbortSignal.timeout(150_000),
        };
        upstream = await fetch(
          `${base}/projects/${projectId}/${resource}${search}`,
          init as RequestInit,
        );
      } catch {
        throw new HttpError(
          503,
          "QUALITY_UNAVAILABLE",
          "质量分析服务未就绪，请检查 quality 容器或 Python 服务",
        );
      }
      if (upstream.ok && write && request.currentUser) {
        await context.audit(
          request.currentUser.id,
          request.method === "POST"
            ? "analysis_uploaded"
            : request.method === "PUT"
              ? "quality_rules_updated"
              : "analysis_deleted",
          "quality_analysis",
          null,
          projectId,
          { resource },
        );
      }
      reply.header("Cache-Control", "no-store");
      if (resource.endsWith("report.html")) {
        reply.header(
          "Content-Disposition",
          'attachment; filename="quality-report.html"',
        );
        reply.header(
          "Content-Security-Policy",
          "default-src 'none'; style-src 'unsafe-inline'",
        );
      }
      return reply
        .code(upstream.status)
        .type(upstream.headers.get("content-type") ?? "application/json")
        .send(Buffer.from(await upstream.arrayBuffer()));
    },
  });
}
