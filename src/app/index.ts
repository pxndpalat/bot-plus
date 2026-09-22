import { Elysia } from "elysia";

/**
 * Bootstrap-only app factory. Feature routes belong to their owning modules.
 */
export function createApp(): Elysia {
  return new Elysia();
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? "3000");

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const server = createApp().listen({ hostname: host, port });
  console.log(`Mallnew Friends Bot listening on ${server.server?.hostname}:${server.server?.port}`);
}
