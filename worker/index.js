// The audio loop exceeds the 25 MiB static asset limit, so it is served from R2
// on the same path. Everything else falls through to static assets.
const AUDIO_PATH = "/assets/clinamen-loop-64k.mp3";
const AUDIO_KEY = "clinamen-loop-64k.mp3";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== AUDIO_PATH) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const object = await env.MEDIA.get(AUDIO_KEY, {
      range: request.headers,
      onlyIf: request.headers,
    });
    if (!object) return new Response("Not Found", { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("ETag", object.httpEtag);
    headers.set("Accept-Ranges", "bytes");
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
    if (!headers.has("Content-Type")) headers.set("Content-Type", "audio/mpeg");

    // onlyIf precondition failed: no body is returned
    if (!("body" in object)) return new Response(null, { status: 304, headers });

    const partial = request.headers.has("Range") && object.range;
    if (partial) {
      const offset = object.range.offset ?? object.size - object.range.suffix;
      const length = object.range.length ?? object.size - offset;
      headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
      headers.set("Content-Length", String(length));
    } else {
      headers.set("Content-Length", String(object.size));
    }

    return new Response(request.method === "HEAD" ? null : object.body, {
      status: partial ? 206 : 200,
      headers,
    });
  },
};
