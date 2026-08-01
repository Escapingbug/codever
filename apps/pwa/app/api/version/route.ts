import { CODEVER_BUILD_VERSION } from "../../buildInfo";

const responseHeaders = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  "cdn-cache-control": "no-store",
  "cloudflare-cdn-cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
  expires: "0",
  pragma: "no-cache",
};

export async function GET(): Promise<Response> {
  return new Response(
    JSON.stringify({ buildVersion: CODEVER_BUILD_VERSION }),
    { status: 200, headers: responseHeaders },
  );
}
