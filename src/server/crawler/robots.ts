/**
 * robots.txt handling (RFC 9309):
 *  - 2xx: parse and obey rules for our user agent.
 *  - 4xx: no restrictions.
 *  - 5xx / network failure: treat as "full disallow" for crawling; the
 *    onboarding crawler then fetches only the homepage the user submitted.
 */
import robotsParser from "robots-parser";

export const ROBOTS_AGENT = "ArelleBot";

export type RobotsStatus = "PARSED" | "MISSING" | "UNAVAILABLE";

export interface RobotsPolicy {
  status: RobotsStatus;
  isAllowed(url: string): boolean;
  crawlDelaySeconds: number | undefined;
  sitemaps: string[];
}

export function parseRobots(robotsUrl: string, body: string): RobotsPolicy {
  // RFC 9309 asks crawlers to parse at least 500 KiB.
  const robots = robotsParser(robotsUrl, body.slice(0, 500 * 1024));
  return {
    status: "PARSED",
    // Unknown → allowed; robots-parser returns undefined for other-origin URLs.
    isAllowed: (url) => robots.isAllowed(url, ROBOTS_AGENT) !== false,
    crawlDelaySeconds: robots.getCrawlDelay(ROBOTS_AGENT),
    sitemaps: robots.getSitemaps(),
  };
}

export const MISSING_ROBOTS: RobotsPolicy = { status: "MISSING", isAllowed: () => true, crawlDelaySeconds: undefined, sitemaps: [] };
export const UNAVAILABLE_ROBOTS: RobotsPolicy = { status: "UNAVAILABLE", isAllowed: () => false, crawlDelaySeconds: undefined, sitemaps: [] };
