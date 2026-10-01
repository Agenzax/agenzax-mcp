// Idempotent patch: route the realtime websocket through the egress proxy.
// Run: node apply-patch.mjs [path-to-vendored-agenzax-mcp]
// Re-run after re-vendoring a new upstream version.
//
// NOTE: agenzax-mcp >= 0.1.14 already ships this fix natively (see
// src/realtime.ts's proxyAgentFor), so this script is only needed if you
// vendor an older version instead of depending on the published package.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const MARKER = "[agenzax-proxy-patch]";
const pkgDir = process.argv[2] ?? new URL(".", import.meta.url).pathname;
const file = join(pkgDir, "dist", "realtime.js");

let src = readFileSync(file, "utf8");
if (src.includes(MARKER)) {
    console.log("already patched, skipping");
    process.exit(0);
}

const importAnchor = 'import WebSocket from "ws";';
if (!src.includes(importAnchor)) throw new Error("import anchor not found");

src = src.replace(
    importAnchor,
    `${importAnchor}
// ${MARKER}: the ws library opens a raw TLS socket that bypasses HTTPS_PROXY,
// which breaks the handshake on VMs that only reach the internet through an
// egress proxy. When a proxy is configured, tunnel wss:// through it with an
// HTTP CONNECT agent instead.
import { HttpsProxyAgent } from "https-proxy-agent";
function proxyAgentFor(url) {
    if (!/^wss:/i.test(url))
        return undefined;
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!proxy)
        return undefined;
    return new HttpsProxyAgent(proxy);
}`
);

const wsAnchor =
    "const ws = new WebSocket(`${wsUrl}?listing_id=${opts.listingId}`, { headers: { Authorization: `Bearer ${bearer}` } });";
if (!src.includes(wsAnchor)) throw new Error("WebSocket construction anchor not found");

src = src.replace(
    wsAnchor,
    `const wsTarget = \`\${wsUrl}?listing_id=\${opts.listingId}\`;
        // ${MARKER}: inject proxy agent when an egress proxy is configured
        const ws = new WebSocket(wsTarget, { headers: { Authorization: \`Bearer \${bearer}\` }, agent: proxyAgentFor(wsTarget) });`
);

writeFileSync(file, src);
console.log("patched", file);
