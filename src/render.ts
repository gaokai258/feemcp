// v0.36: markdown / CSV renderers for the three decision matrices
// (compare_personas, volume_what_if, compare_countries). Pure functions over
// the already-computed JSON result — no fee math lives here.
import type {
  CompareCountriesResult,
  PersonaComparisonResult,
  RenderFormat,
  RenderedTable,
  VolumeWhatIfResult,
} from "./types.js";
import type { Lang } from "./i18n.js";

export type { RenderFormat, RenderedTable };

const LABELS = {
  en: {
    exchange: "Exchange",
    persona: "Persona",
    monthly_volume: "Monthly volume (USD)",
    venue: "Venue",
    country: "Country",
    annual: "Annual all-in (USD)",
    weighted: "Weighted fee (%)",
    annual_fee: "Annual trading fee (USD)",
    tier: "Effective tier",
    availability: "Availability",
    cost: "Annual all-in (USD)",
    available: "✓",
    blocked: "⛔",
    unsupported: "–",
    legend_rail: "† venue misses a rail/route for this persona (cost leg excluded)",
    legend_status: "✓ available · ⛔ compliance-blocked · – product unsupported",
    title_personas: "Persona × venue annual all-in cost — {country}",
    title_whatif: "Weighted fee (%) by monthly volume — {purpose}",
    title_countries_avail: "Venue availability by country — {persona}",
    title_countries_cost: "Venue annual all-in cost (USD) by country — {persona}",
  },
  zh: {
    exchange: "交易所",
    persona: "画像",
    monthly_volume: "月成交量（USD）",
    venue: "交易所",
    country: "国家",
    annual: "年化总成本（USD）",
    weighted: "加权费率（%）",
    annual_fee: "年化交易费（USD）",
    tier: "生效档位",
    availability: "可用性",
    cost: "年化总成本（USD）",
    available: "✓",
    blocked: "⛔",
    unsupported: "–",
    legend_rail: "† 该所缺少此画像的某项成本通道（该成本腿已排除，按未计处理）",
    legend_status: "✓ 可用 · ⛔ 合规封锁 · – 不提供该产品",
    title_personas: "画像 × 交易所 年化总成本矩阵——{country}",
    title_whatif: "各月成交量下的加权费率（%）——{purpose}",
    title_countries_avail: "各交易所跨国可用性矩阵——{persona}",
    title_countries_cost: "各交易所跨国年化总成本（USD）——{persona}",
  },
} as const;

type Labels = { [K in keyof (typeof LABELS)["en"]]: string };

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function mdCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function toMarkdown(headers: string[], rows: (string | number)[][]): string {
  const lines: string[] = [];
  lines.push(`| ${headers.map(mdCell).join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines.push(`| ${row.map(mdCell).join(" | ")} |`);
  return lines.join("\n");
}

function toCsv(headers: string[], rows: (string | number)[][]): string {
  const lines: string[] = [];
  lines.push(headers.map(csvCell).join(","));
  for (const row of rows) lines.push(row.map(csvCell).join(","));
  return lines.join("\r\n");
}

function compactUsd(v: number): string {
  if (v >= 1e9) return `$${trim1(v / 1e9)}B`;
  if (v >= 1e6) return `$${trim1(v / 1e6)}M`;
  if (v >= 1e3) return `$${trim1(v / 1e3)}K`;
  return `$${Math.round(v)}`;
}

function trim1(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

function fmtNum(v: number, dp = 2): string {
  return (Math.round(v * 10 ** dp) / 10 ** dp).toString();
}

// ---------------------------------------------------------------------------
// persona matrix — venue rows × persona columns, annual all-in cost
// ---------------------------------------------------------------------------

export function renderPersonaMatrix(
  r: PersonaComparisonResult,
  lang: Lang,
): { markdown: string; csv: string } {
  const L: Labels = LABELS[lang];
  const headers = [L.exchange, ...r.personas.map((p) => (lang === "zh" ? p.persona.name_zh : p.persona.name_en))];
  const mdRows: (string | number)[][] = [];
  const csvRows: (string | number)[][] = [];
  for (const ex of r.venues) {
    const mdRow: (string | number)[] = [ex];
    const csvRow: (string | number)[] = [ex];
    for (const p of r.personas) {
      const cell = p.matrix.find((m) => m.exchange === ex);
      mdRow.push(cell ? `${fmtNum(cell.annual_all_in)}${cell.withdrawal_unsupported ? " †" : ""}` : "");
      csvRow.push(cell ? fmtNum(cell.annual_all_in) : "");
    }
    mdRows.push(mdRow);
    csvRows.push(csvRow);
  }
  const title = L.title_personas.replace("{country}", r.country);
  return {
    markdown: [title, "", toMarkdown(headers, mdRows), "", L.legend_rail].join("\n"),
    csv: toCsv(headers, csvRows),
  };
}

// ---------------------------------------------------------------------------
// volume what-if — monthly-volume rows × venue columns
// metric: weighted_fee_pct (default) | annual_fee_usd | tier
// ---------------------------------------------------------------------------

export type WhatIfMetric = "weighted_fee_pct" | "annual_fee_usd" | "tier";

export function renderWhatIf(
  r: VolumeWhatIfResult,
  lang: Lang,
  metric: WhatIfMetric = "weighted_fee_pct",
): { markdown: string; csv: string } {
  const L: Labels = LABELS[lang];
  const headers = [L.monthly_volume, ...r.exchanges.map((e) => e.exchange)];
  const mdRows: (string | number)[][] = [];
  const csvRows: (string | number)[][] = [];
  for (const p of r.points) {
    const mdRow: (string | number)[] = [compactUsd(p.monthly_volume_usd)];
    const csvRow: (string | number)[] = [p.monthly_volume_usd];
    for (const ex of r.exchanges) {
      const cell = p.ranking.find((x) => x.exchange === ex.exchange);
      if (!cell) {
        mdRow.push("");
        csvRow.push("");
        continue;
      }
      if (metric === "annual_fee_usd") {
        mdRow.push(fmtNum(cell.annual_fee_usd));
        csvRow.push(fmtNum(cell.annual_fee_usd));
      } else if (metric === "tier") {
        mdRow.push(cell.tier);
        csvRow.push(cell.tier);
      } else {
        mdRow.push(fmtNum(cell.weighted_fee_pct, 4));
        csvRow.push(fmtNum(cell.weighted_fee_pct, 4));
      }
    }
    mdRows.push(mdRow);
    csvRows.push(csvRow);
  }
  const title = L.title_whatif.replace("{purpose}", r.purpose);
  return {
    markdown: [title, "", toMarkdown(headers, mdRows)].join("\n"),
    csv: toCsv([L.monthly_volume, ...r.exchanges.map((e) => e.exchange)], csvRows),
  };
}

// ---------------------------------------------------------------------------
// country matrix
// metric: availability (default) | cost (venue annual cost per country)
// ---------------------------------------------------------------------------

export type CountryMetric = "availability" | "cost";

export function renderCountries(
  r: CompareCountriesResult,
  lang: Lang,
  metric: CountryMetric = "availability",
): { markdown: string; csv: string } {
  const L: Labels = LABELS[lang];
  const personaName = lang === "zh" ? r.persona.name_zh : r.persona.name_en;
  const headers = [L.venue, ...r.countries];

  if (metric === "cost") {
    const mdRows: (string | number)[][] = [];
    const csvRows: (string | number)[][] = [];
    const venues = new Set<string>();
    for (const row of r.rows) for (const x of row.ranking) venues.add(x.exchange);
    for (const ex of venues) {
      const mdRow: (string | number)[] = [ex];
      const csvRow: (string | number)[] = [ex];
      for (const c of r.rows) {
        const cell = c.ranking.find((x) => x.exchange === ex);
        mdRow.push(cell ? fmtNum(cell.annual_all_in) : "");
        csvRow.push(cell ? fmtNum(cell.annual_all_in) : "");
      }
      mdRows.push(mdRow);
      csvRows.push(csvRow);
    }
    const title = L.title_countries_cost.replace("{persona}", personaName);
    return {
      markdown: [title, "", toMarkdown(headers, mdRows)].join("\n"),
      csv: toCsv(headers, csvRows),
    };
  }

  const mdRows: (string | number)[][] = [];
  const csvRows: (string | number)[][] = [];
  for (const va of r.venue_availability) {
    const mdRow: (string | number)[] = [va.exchange];
    const csvRow: (string | number)[] = [va.exchange];
    for (const cc of r.countries) {
      const status = va.per_country[cc];
      mdRow.push(
        status === "blocked" ? L.blocked : status === "unsupported_product" ? L.unsupported : L.available,
      );
      csvRow.push(status);
    }
    mdRows.push(mdRow);
    csvRows.push(csvRow);
  }
  const title = L.title_countries_avail.replace("{persona}", personaName);
  return {
    markdown: [title, "", toMarkdown(headers, mdRows), "", L.legend_status].join("\n"),
    csv: toCsv(headers, csvRows),
  };
}

// ---------------------------------------------------------------------------
// single entry point — honor the requested format(s)
// ---------------------------------------------------------------------------

export function renderTable(
  kind: "personas" | "whatif" | "countries",
  result: PersonaComparisonResult | VolumeWhatIfResult | CompareCountriesResult,
  format: Exclude<RenderFormat, "json">,
  lang: Lang,
  metric?: string,
): RenderedTable {
  const out =
    kind === "personas"
      ? renderPersonaMatrix(result as PersonaComparisonResult, lang)
      : kind === "whatif"
        ? renderWhatIf(
            result as VolumeWhatIfResult,
            lang,
            (metric as WhatIfMetric | undefined) ?? "weighted_fee_pct",
          )
        : renderCountries(
            result as CompareCountriesResult,
            lang,
            (metric as CountryMetric | undefined) ?? "availability",
          );
  const metricName =
    metric ??
    (kind === "personas"
      ? "annual_all_in"
      : kind === "whatif"
        ? "weighted_fee_pct"
        : "availability");
  const table: RenderedTable = { metric: metricName };
  if (format === "markdown" || format === "both") table.markdown = out.markdown;
  if (format === "csv" || format === "both") table.csv = out.csv;
  return table;
}
