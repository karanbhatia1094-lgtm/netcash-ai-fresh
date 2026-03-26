import fs from "node:fs";
import path from "node:path";

const outputPath = path.resolve("docs", "netcash_investor_deck.pdf");
const markdownPath = path.resolve("docs", "netcash_investor_deck.md");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const title = "Netcash.ai - Profitability OS for Shopify Brands";
const subtitle = "Founder/Investor Summary Deck";

const featureCatalogPath = path.resolve("docs", "NETCASH_FEATURES_CATALOG.html");
const featureCatalogHtml = fs.existsSync(featureCatalogPath)
  ? fs.readFileSync(featureCatalogPath, "utf8")
  : "";

const featureRows = [];
const featureRowRegex = /<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g;
let match;
while ((match = featureRowRegex.exec(featureCatalogHtml)) !== null) {
  const [_, feature, enables, why] = match;
  if (!feature || feature.toLowerCase().includes("feature")) continue;
  featureRows.push({
    feature: feature.replace(/<[^>]+>/g, "").trim(),
    enables: enables.replace(/<[^>]+>/g, "").trim(),
    why: why.replace(/<[^>]+>/g, "").trim(),
  });
}

const featureHighlights = featureRows.map((row) => `- ${row.feature}: ${row.enables}`);
const opsStartIndex = featureRows.findIndex((row) =>
  row.feature.toLowerCase().includes("shopify webhook"),
);
const opsHighlights = (opsStartIndex >= 0 ? featureRows.slice(opsStartIndex) : []).map(
  (row) => `- ${row.feature}: ${row.enables}`,
);

const sections = [
  {
    heading: "What it is",
    body:
      "Netcash.ai is a profitability-first analytics and action layer for Shopify brands. It combines order-level net cash, ad spend, and attribution signals to show the true unit economics of every campaign and customer cohort.",
  },
  {
    heading: "The problem",
    body:
      "Most ecommerce teams optimize for top-line ROAS while hidden costs (returns, RTO, refunds, discounts, shipping, and payment fees) erode actual profit. Teams lack a single, reliable view of net cash and a workflow to act on it.",
  },
  {
    heading: "How it works",
    body:
      "Netcash.ai pulls Shopify order data, normalizes attribution signals, and merges ad spend from connectors. It computes net cash KPIs, identifies risk patterns, and recommends actions. Teams review insights in a unified dashboard and take action directly from the app.",
  },
  {
    heading: "Core product features (full list)",
    body: featureHighlights.join("\n"),
  },
  {
    heading: "Ops and reliability",
    body: opsHighlights.length ? opsHighlights.join("\n") : "Operational items included in catalog.",
  },
  {
    heading: "Use cases we solve",
    body:
      "Founder and finance teams: net cash visibility and ROI confidence.\nPerformance teams: campaign-level real ROAS and budget reallocation.\nOps and CX: alerting on anomalies and root-cause diagnosis.\nRetention teams: customer 360 and cohort intelligence.",
  },
  {
    heading: "Impact",
    body:
      "Replaces guesswork with a profitability operating system. Teams see which campaigns create real profit, cut waste early, and focus spend on winners. The result is better contribution margin and faster decision cycles.",
  },
  {
    heading: "Why now",
    body:
      "Ad costs are rising, attribution is noisier, and return costs are increasing. Brands can no longer optimize for top-line ROAS alone. Profitability-first analytics is now a core requirement, not a nice-to-have.",
  },
  {
    heading: "Market (TAM/SAM/SOM)",
    body:
      "Shopify powers millions of merchants globally, with a fast-growing subset of D2C brands spending heavily on paid acquisition. Netcash.ai targets performance-driven brands that need profitability visibility and repeatable decision workflows. The platform expands naturally into mid-market and agency-led portfolios.",
  },
];

const gtmdSections = [
  {
    heading: "Go-To-Market",
    body:
      "Land with Shopify-first distribution, founder-led sales for early adopters, and content-led education around net cash analytics. Expand through agency partnerships and performance marketing teams that manage multiple stores.",
  },
  {
    heading: "Business model",
    body:
      "Subscription SaaS with tiered plans (Starter/Pro/Premium) based on features, scale, and automation depth. Upsell paths include reports, automation bundles, and multi-store operator workspaces.",
  },
  {
    heading: "Growth plan",
    body:
      "Phase 1: product proof with 10-30 pilot brands. Phase 2: scale distribution via Shopify marketplace and agency channels. Phase 3: expand into mid-market with multi-store analytics and automation bundles.",
  },
  {
    heading: "Traction (placeholder)",
    body:
      "Early pilots show improved visibility into real ROAS and faster decision cycles. Add concrete metrics here: active stores, MRR, retention, and before/after ROI improvements.",
  },
];

const roadmapSections = [
  {
    heading: "Roadmap",
    body:
      "1) Deeper profitability attribution across channels. 2) Automated action workflows (budget shifts, alerts-to-actions). 3) Self-serve onboarding with guided setup. 4) Expand connector ecosystem and multi-store portfolio analytics.",
  },
  {
    heading: "Moat",
    body:
      "Netcash.ai builds a proprietary net-cash data model and action layer, not just dashboards. As the dataset grows, recommendations become increasingly contextual and defensible.",
  },
  {
    heading: "The ask",
    body:
      "Raise a seed round to scale product depth, grow GTM, and expand integrations. Hiring focus: data engineering, growth, and partner enablement.",
  },
];

const wrapText = (text, maxLen) => {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!line) {
      line = word;
      continue;
    }
    if ((line + " " + word).length > maxLen) {
      lines.push(line);
      line = word;
    } else {
      line += " " + word;
    }
  }
  if (line) lines.push(line);
  return lines;
};

const pushSectionLines = (out, sectionList) => {
  for (const section of sectionList) {
    out.push({ text: section.heading, size: 13, gap: 8 });
    const bodyLines = wrapText(section.body, 95);
    for (const line of bodyLines) {
      out.push({ text: line, size: 11, gap: 4 });
    }
    out.push({ text: "", size: 11, gap: 8 });
  }
};

const makeLines = () => {
  const out = [];
  out.push({ text: title, size: 18, gap: 8 });
  out.push({ text: subtitle, size: 12, gap: 12 });
  pushSectionLines(out, sections);
  out.push({ text: "__PAGE_BREAK__", size: 11, gap: 0 });
  pushSectionLines(out, gtmdSections);
  out.push({ text: "__PAGE_BREAK__", size: 11, gap: 0 });
  pushSectionLines(out, roadmapSections);
  return out;
};

const buildPdf = (lines) => {
  const pageWidth = 612;
  const pageHeight = 792;
  const marginX = 50;
  const topY = 760;
  const bottomY = 60;

  const pages = [];
  let current = [];
  let y = topY;

  for (const entry of lines) {
    if (entry.text === "__PAGE_BREAK__") {
      pages.push(current);
      current = [];
      y = topY;
      continue;
    }
    const size = entry.size || 11;
    const gap = entry.gap || 4;
    if (y - size < bottomY) {
      pages.push(current);
      current = [];
      y = topY;
    }
    current.push({ text: entry.text, size, y });
    y -= size + gap;
  }
  if (current.length) pages.push(current);

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const fontObj = addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  );

  const pageObjs = [];

  for (const page of pages) {
    let content = "BT\n";
    for (const line of page) {
      const escaped = line.text
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
      content += `/F1 ${line.size} Tf 1 0 0 1 ${marginX} ${line.y} Tm (${escaped}) Tj\n`;
    }
    content += "ET";
    const contentLen = Buffer.byteLength(content, "utf8");
    const contentObj = addObject(
      `<< /Length ${contentLen} >>\nstream\n${content}\nendstream`,
    );
    const pageObj = addObject(
      `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`,
    );
    pageObjs.push(pageObj);
  }

  const pagesObj = addObject(
    `<< /Type /Pages /Count ${pageObjs.length} /Kids [${pageObjs
      .map((id) => `${id} 0 R`)
      .join(" ")}] >>`,
  );

  const catalogObj = addObject(
    `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`,
  );

  const header = "%PDF-1.4\n";
  const bodyChunks = [];
  const xref = [];
  let offset = Buffer.byteLength(header, "utf8");

  const replaceParents = () => {
    for (let i = 0; i < objects.length; i += 1) {
      if (objects[i].includes("/Parent 0 0 R")) {
        objects[i] = objects[i].replace(
          "/Parent 0 0 R",
          `/Parent ${pagesObj} 0 R`,
        );
      }
    }
  };
  replaceParents();

  for (let i = 0; i < objects.length; i += 1) {
    const objNum = i + 1;
    const objStr = `${objNum} 0 obj\n${objects[i]}\nendobj\n`;
    xref.push(offset);
    bodyChunks.push(objStr);
    offset += Buffer.byteLength(objStr, "utf8");
  }

  let xrefTable = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const ref of xref) {
    xrefTable += `${String(ref).padStart(10, "0")} 00000 n \n`;
  }

  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${offset}\n%%EOF\n`;

  return header + bodyChunks.join("") + xrefTable + trailer;
};

const lines = makeLines();
const pdf = buildPdf(lines);
fs.writeFileSync(outputPath, pdf);
const markdown = [
  `# ${title}`,
  "",
  `## ${subtitle}`,
  "",
  "## What it is",
  sections[0].body,
  "",
  "## The problem",
  sections[1].body,
  "",
  "## How it works",
  sections[2].body,
  "",
  "## Core product features (full list)",
  ...featureHighlights,
  "",
  "## Ops and reliability",
  ...(opsHighlights.length ? opsHighlights : ["- Operational items included in catalog."]),
  "",
  "## Use cases we solve",
  sections[5].body,
  "",
  "## Impact",
  sections[6].body,
  "",
  "## Why now",
  sections[7].body,
  "",
  "## Market (TAM/SAM/SOM)",
  sections[8].body,
  "",
  "## Go-To-Market",
  gtmdSections[0].body,
  "",
  "## Business model",
  gtmdSections[1].body,
  "",
  "## Growth plan",
  gtmdSections[2].body,
  "",
  "## Traction (placeholder)",
  gtmdSections[3].body,
  "",
  "## Roadmap",
  roadmapSections[0].body,
  "",
  "## Moat",
  roadmapSections[1].body,
  "",
  "## The ask",
  roadmapSections[2].body,
  "",
].join("\n");
fs.writeFileSync(markdownPath, markdown);
console.log(`Wrote ${outputPath}`);
