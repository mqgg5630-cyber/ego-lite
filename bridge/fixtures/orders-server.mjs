#!/usr/bin/env node
/**
 * Fixture server for bridge task t5-checkout-flow.
 *
 * A deliberately boring back office: sign in with any email, filter orders by
 * status, page through them, export the filtered set as CSV. Everything is
 * cookie-gated so the task proves the browser keeps a session, and the data is
 * generated from a fixed seed so reruns are byte-identical.
 *
 *   node bridge/fixtures/orders-server.mjs   # http://127.0.0.1:8787
 */

import { createServer } from "node:http";

const PORT = Number(process.env.FIXTURE_PORT || 8787);
const HOST = process.env.FIXTURE_HOST || "127.0.0.1";
const PAGE_SIZE = 5;

const CUSTOMERS = [
  "Ada Lovelace",
  "Grace Hopper",
  "Alan Turing",
  "Katherine Johnson",
  "Edsger Dijkstra",
  "Barbara Liskov",
  "Ken Thompson",
  "Margaret Hamilton",
  "Donald Knuth",
  "Radia Perlman",
  "Tony Hoare",
  "Frances Allen",
];

/** Deterministic pseudo-random so the fixture never surprises the agent. */
function seeded(seed) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

const random = seeded(20261105);
const ORDERS = CUSTOMERS.map((customer, index) => {
  const amount = Math.round((40 + random() * 400) * 100) / 100;
  return {
    id: `ORD-${1000 + index}`,
    customer,
    total: amount,
    status: index % 3 === 0 ? "Refunded" : index % 5 === 0 ? "Pending" : "Paid",
  };
});

const page = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:15px/1.55 ui-sans-serif,system-ui;margin:32px;max-width:820px;color:#111}
 table{border-collapse:collapse;width:100%;margin:1em 0}
 th,td{border-bottom:1px solid #e5e7eb;padding:.45em .6em;text-align:left}
 th{background:#f8fafc;font-weight:600}
 button{padding:.45em .9em;border:1px solid #d4d4d8;background:#fff;border-radius:6px;cursor:pointer}
 button:disabled{opacity:.45;cursor:default}
 input,select{padding:.4em .5em;border:1px solid #d4d4d8;border-radius:6px}
 code{background:#f4f4f5;padding:.1em .3em;border-radius:4px}
</style>${body}`;

function signedIn(req) {
  return /(?:^|;\s*)fixture_session=[^;]+/.test(req.headers.cookie || "");
}

function loginPage() {
  return page(
    "Fixture back office — sign in",
    `<h1>Fixture back office</h1>
     <p>This is a local page served from your laptop. Sign in with any address.</p>
     <form id="login" method="post" action="/login">
       <p><label>Email <input id="email" name="email" autocomplete="off" required></label></p>
       <p><button type="submit">Sign in</button></p>
     </form>`,
  );
}

function ordersPage({ status, cursor, email }) {
  const filtered = status ? ORDERS.filter((order) => order.status === status) : ORDERS;
  const start = Number(cursor || 0);
  const visible = filtered.slice(start, start + PAGE_SIZE);
  const nextCursor = start + PAGE_SIZE < filtered.length ? start + PAGE_SIZE : null;
  const query = (extra) =>
    "?" +
    new URLSearchParams({ status, cursor: String(extra.cursor ?? start), email, export: extra.export || "" })
      .toString()
      .replace(/(?:status=&|export=&)/g, "");

  return page(
    "Fixture orders",
    `<h1 id="orders">Orders</h1>
     <p>Signed in as <code id="who">${email}</code>. ${filtered.length} orders match.</p>
     <p>
       <label>Status
         <select id="status" onchange="location.href='/orders?status='+this.value">
           ${["", "Paid", "Pending", "Refunded"]
             .map(
               (value) =>
                 `<option value="${value}"${value === status ? " selected" : ""}>${
                   value || "All"
                 }</option>`,
             )
             .join("")}
         </select>
       </label>
       <button id="export" onclick="location.href='/export?status=${status}'">Export CSV</button>
     </p>
     <table>
       <thead><tr><th>Order</th><th>Customer</th><th>Total</th><th>Status</th></tr></thead>
       <tbody id="rows">
         ${visible
           .map(
             (order) =>
               `<tr><td>${order.id}</td><td>${order.customer}</td><td>$${order.total.toFixed(
                 2,
               )}</td><td>${order.status}</td></tr>`,
           )
           .join("")}
       </tbody>
     </table>
     <p>
       <button id="next" ${nextCursor === null ? "disabled" : ""}
         onclick="location.href='/orders${query({ cursor: nextCursor })}'">Next page</button>
     </p>`,
  );
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/login" && req.method === "POST") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const email = form.get("email") || "guest@example.test";
      res.writeHead(302, {
        "set-cookie": `fixture_session=${encodeURIComponent(email)}; Path=/; SameSite=Lax`,
        location: `/orders?email=${encodeURIComponent(email)}`,
      });
      res.end();
    });
    return;
  }

  if (url.pathname === "/export") {
    if (!signedIn(req)) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    const status = url.searchParams.get("status") || "";
    const rows = status ? ORDERS.filter((order) => order.status === status) : ORDERS;
    const csv = ["id,customer,status,total"]
      .concat(rows.map((order) => `${order.id},${order.customer},${order.status},${order.total}`))
      .join("\n");
    res.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="orders-${status || "all"}.csv"`,
    });
    res.end(csv);
    return;
  }

  if (url.pathname === "/orders") {
    if (!signedIn(req)) {
      res.writeHead(302, { location: "/" });
      res.end();
      return;
    }
    const email =
      url.searchParams.get("email") || decodeURIComponent((req.headers.cookie || "").split("=")[1] || "");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      ordersPage({
        status: url.searchParams.get("status") || "",
        cursor: url.searchParams.get("cursor") || 0,
        email,
      }),
    );
    return;
  }

  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(signedIn(req) ? ordersPage({ status: "", cursor: 0, email: "you" }) : loginPage());
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(PORT, HOST, () => {
  console.log(`[fixture] orders back office on http://${HOST}:${PORT}`);
});
