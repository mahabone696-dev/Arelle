// Browsers request /favicon.ico directly (e.g. on JSON responses); point them at the app icon.
export function GET(request: Request) {
  return Response.redirect(new URL("/icon.svg", request.url), 308);
}
