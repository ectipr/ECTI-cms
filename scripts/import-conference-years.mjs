#!/usr/bin/env node
/**
 * Fills in the year + website rows on Publications — Conferences from CSV.
 *
 * Fifty-two rows across four conferences, every one of them a long URL that is
 * easy to mistype and impossible to spot afterwards: a wrong character in
 * ecticard2016.ecticard.org produces a link that looks exactly like the right
 * one in the admin and 404s for a reader.
 *
 * The CSVs live next to this file and are the source of record. Adding next
 * year's conference means a line in the CSV and a re-run, not a trip through
 * the admin form.
 *
 *   STRAPI_URL=... STRAPI_API_TOKEN=... node scripts/import-conference-years.mjs --dry-run
 *   STRAPI_URL=... STRAPI_API_TOKEN=... node scripts/import-conference-years.mjs
 *   STRAPI_URL=... STRAPI_API_TOKEN=... node scripts/import-conference-years.mjs --replace
 *
 * A conference that already has rows is left alone unless --replace is given.
 * Without that, a re-run after someone fixed a link by hand in the admin would
 * put the CSV's version back without saying so.
 *
 * The token needs write access to conference.
 */

import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { api, requireToken, STRAPI_URL } from "./lib/strapi.mjs";

const CSV_DIR = join(dirname(fileURLToPath(import.meta.url)), "data", "conference-years");

/** Matches the `regex` on the component's year attribute, so a bad row is
 *  reported here by name rather than coming back as a validation error with an
 *  array index in it. */
const YEAR_RE = /^\d{4}$/;
const LINK_RE = /^https?:\/\/.+/;

function parseArgs(argv) {
  const args = { dryRun: false, replace: false };
  for (const flag of argv) {
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--replace") args.replace = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  return args;
}

/**
 * Reads a `year,link` file.
 *
 * Split on the first comma only: several of these links carry query strings,
 * and a split on every comma would quietly truncate one the day a URL contains
 * one.
 */
function parseCsv(text, file) {
  const rows = [];
  const problems = [];

  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (index === 0 && /^year\s*,/i.test(trimmed)) return; // header

    const comma = trimmed.indexOf(",");
    if (comma === -1) {
      problems.push(`${file}:${index + 1} has no comma: ${trimmed}`);
      return;
    }

    const year = trimmed.slice(0, comma).trim();
    const link = trimmed.slice(comma + 1).trim();

    if (!YEAR_RE.test(year)) problems.push(`${file}:${index + 1} year "${year}" is not four digits`);
    else if (link && !LINK_RE.test(link)) problems.push(`${file}:${index + 1} link does not start with http: ${link}`);
    else rows.push({ year, ...(link ? { link } : {}) });
  });

  return { rows, problems };
}

/** ecti-con.csv → ECTI-CON, which is how the titles are written in the CMS. */
function titleFor(file) {
  return basename(file, ".csv").toUpperCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(
      "Usage: STRAPI_URL=... STRAPI_API_TOKEN=... node scripts/import-conference-years.mjs\n" +
        "       [--dry-run] [--replace]"
    );
    return;
  }

  requireToken();
  console.log(`Target ${STRAPI_URL}\n`);

  const files = (await readdir(CSV_DIR)).filter((f) => f.endsWith(".csv")).sort();
  if (files.length === 0) throw new Error(`No CSV files in ${CSV_DIR}`);

  // Everything is read and checked before anything is written. A run that fails
  // on the third of four conferences leaves the page half updated, and which
  // half is not obvious from looking at it.
  const planned = [];
  const problems = [];

  for (const file of files) {
    const { rows, problems: fileProblems } = parseCsv(await readFile(join(CSV_DIR, file), "utf8"), file);
    problems.push(...fileProblems);
    if (rows.length > 0) planned.push({ file, title: titleFor(file), rows });
  }

  if (problems.length > 0) {
    console.error("The CSVs have problems, so nothing was written:\n");
    for (const p of problems) console.error(`  ${p}`);
    process.exitCode = 1;
    return;
  }

  // One request for all of them: four conferences is the whole collection.
  const existing = await api("/api/conferences?locale=th&populate=year_links&pagination[pageSize]=100");
  const byTitle = new Map(existing.data.map((c) => [String(c.title ?? "").toUpperCase(), c]));

  const toWrite = [];
  for (const entry of planned) {
    const conference = byTitle.get(entry.title);

    if (!conference) {
      console.log(`  ${entry.title.padEnd(10)} not in the CMS — skipping ${entry.file}`);
      continue;
    }

    const already = conference.year_links?.length ?? 0;
    if (already > 0 && !args.replace) {
      console.log(`  ${entry.title.padEnd(10)} already has ${already} rows — skipping (--replace to overwrite)`);
      continue;
    }

    const verb = already > 0 ? `replacing ${already} rows with` : "writing";
    const withLinks = entry.rows.filter((r) => r.link).length;
    console.log(
      `  ${entry.title.padEnd(10)} ${verb} ${entry.rows.length} rows ` +
        `(${entry.rows[0].year}–${entry.rows[entry.rows.length - 1].year}, ${withLinks} with a link)`
    );
    toWrite.push({ ...entry, documentId: conference.documentId });
  }

  if (toWrite.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  if (args.dryRun) {
    console.log("\nDry run — nothing was written. Re-run without --dry-run.");
    return;
  }

  console.log();
  for (const entry of toWrite) {
    // locale=th because the document has to be addressed through one, not
    // because the rows differ: year_links is not localized, so this one write
    // is what both languages read.
    await api(`/api/conferences/${entry.documentId}?locale=th`, {
      method: "PUT",
      body: JSON.stringify({ data: { year_links: entry.rows } }),
    });
    console.log(`  wrote ${entry.title}`);
  }

  console.log(`\nDone. Check /publications — the years should be there and the linked ones clickable.`);
  console.log(`A year with no link is expected: several of the older sites are gone.`);
}

main().catch((err) => {
  console.error(`\n${err.message}\n`);
  process.exitCode = 1;
});
