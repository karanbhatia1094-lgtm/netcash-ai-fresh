import { json } from "@remix-run/node";

export async function loader() {
  return json({ ok: true });
}

export async function action() {
  return json({ ok: true });
}

export default function PingRoute() {
  return null;
}
