#!/usr/bin/env node

/**
 * NYU Bulletin Course Scraper
 *
 * Scrapes course data from bulletins.nyu.edu for all undergraduate schools.
 * Outputs JSON files with course codes, names, credits, descriptions, and prerequisites.
 *
 * Usage:
 *   node scripts/scrape-bulletin.mjs                     # Scrape all schools
 *   node scripts/scrape-bulletin.mjs --school shanghai    # Scrape one school
 *   node scripts/scrape-bulletin.mjs --school shanghai --subject csci-shu  # One subject
 *   node scripts/scrape-bulletin.mjs --list-schools       # List available schools
 *   node scripts/scrape-bulletin.mjs --list-subjects      # List subjects for a school
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "scraped-data");
const BASE_URL = "https://bulletins.nyu.edu";

// Rate limiting: wait between requests to be respectful
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTML Parsing Helpers (no dependencies)

function stripTags(html) {
  return html.replace(/<[^>]*>/g, "").trim();
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function cleanText(html) {
  return decodeEntities(stripTags(html)).replace(/\s+/g, " ").trim();
}

async function fetchPage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Step 1: Get all schools

async function getSchools() {
  const html = await fetchPage(`${BASE_URL}/undergraduate/`);

  // Match links like /undergraduate/shanghai/ or /undergraduate/arts-science/
  const linkRegex =
    /href="(\/undergraduate\/([a-z0-9-]+)\/)"[^>]*>(.*?)<\/a>/gi;
  const schools = [];
  const seen = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const [, path, slug, nameHtml] = match;
    // Skip non-school links
    if (
      [
        "courses",
        "class-search",
        "programs",
        "archive",
        "policies",
      ].includes(slug)
    )
      continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    schools.push({
      slug,
      name: cleanText(nameHtml),
      path,
    });
  }

  return schools;
}

// Step 2: Get subjects for a school

async function getSubjects(schoolSlug) {
  const url = `${BASE_URL}/undergraduate/${schoolSlug}/courses/`;
  let html;
  try {
    html = await fetchPage(url);
  } catch {
    // Some schools may not have a /courses/ page
    return [];
  }

  // Match links like /undergraduate/shanghai/courses/csci-shu/
  const linkRegex = new RegExp(
    `href="(/undergraduate/${schoolSlug}/courses/([a-z0-9-]+)/)"[^>]*>(.*?)</a>`,
    "gi",
  );
  const subjects = [];
  const seen = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const [, path, slug, nameHtml] = match;
    if (seen.has(slug)) continue;
    seen.add(slug);
    subjects.push({
      slug,
      code: slug.toUpperCase().replace(/-/g, "-"),
      name: cleanText(nameHtml),
      path,
    });
  }

  return subjects;
}

// ─── Step 3: Get programs (majors/minors) for a school ───

async function getPrograms(schoolSlug) {
  const url = `${BASE_URL}/undergraduate/${schoolSlug}/programs/`;
  let html;
  try {
    html = await fetchPage(url);
  } catch {
    return [];
  }

  const linkRegex = new RegExp(
    `href="(/undergraduate/${schoolSlug}/programs/([a-z0-9-]+)/)"[^>]*>(.*?)</a>`,
    "gi",
  );
  const programs = [];
  const seen = new Set();
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const [, path, slug, nameHtml] = match;
    if (seen.has(slug)) continue;
    seen.add(slug);
    programs.push({
      slug,
      name: cleanText(nameHtml),
      path,
    });
  }

  return programs;
}

// ─── Step 4: Scrape courses from a subject page ───

async function scrapeCourses(subjectPath) {
  const url = `${BASE_URL}${subjectPath}`;
  const html = await fetchPage(url);

  // Split by courseblock divs
  // The HTML uses: <div class="courseblock">
  const parts = html.split(/<div\s+class="courseblock">/i);
  const courses = [];

  // Skip the first part (before any courseblock)
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const course = parseCourseBlock(block);
    if (course) courses.push(course);
  }

  return courses;
}

function parseCourseBlock(block) {
  // Extract code: <span class="text detail-code ..."><strong>CSCI-SHU 11</strong></span>
  const codeMatch = block.match(/detail-code[^>]*>.*?<strong>(.*?)<\/strong>/is);
  if (!codeMatch) return null;
  const code = cleanText(codeMatch[1]);

  // Extract name: <span class="text detail-title ..."><strong>Name</strong></span>
  const nameMatch = block.match(/detail-title[^>]*>.*?<strong>(.*?)<\/strong>/is);
  const name = nameMatch ? cleanText(nameMatch[1]) : "";

  // Extract credits: <span class="text detail-hours_html ..."><strong>(4 Credits)</strong></span>
  const creditsMatch = block.match(/detail-hours_html[^>]*>.*?<strong>\((\d+(?:-\d+)?)\s*Credits?\)/is);
  const creditsRaw = creditsMatch ? creditsMatch[1] : "4";
  const credits = creditsRaw.includes("-") ? creditsRaw : parseInt(creditsRaw, 10);

  // Extract typically offered
  const offeredMatch = block.match(/detail-typically_offered[^>]*>.*?<\/span>(.*?)<\/i>/is);
  const typicallyOffered = offeredMatch ? cleanText(offeredMatch[1]) : "";

  // Extract description + prerequisites from courseblockextra
  const extraMatch = block.match(/class="courseblockextra[^"]*"[^>]*>([\s\S]*?)(?:<\/div>)/i);
  const extraText = extraMatch ? cleanText(extraMatch[1]) : "";

  // Split description from prerequisite/fulfillment lines
  let description = extraText;
  let prerequisiteNote = "";
  let fulfillment = "";

  const prereqMatch = extraText.match(/(?:Pre-?requisites?|Pre-?req)[:\s]+(.+?)(?=(?:Equivalency|Fulfillment|Note:|$))/i);
  if (prereqMatch) {
    prerequisiteNote = prereqMatch[1].trim().replace(/\s+/g, " ");
  }

  const fulfillMatch = extraText.match(/Fulfillment[:\s]+(.+?)(?=(?:Note:|$))/i);
  if (fulfillMatch) {
    fulfillment = fulfillMatch[1].trim();
  }

  // Clean description: remove prerequisite/fulfillment/note lines
  description = description
    .replace(/(?:Pre-?requisites?|Pre-?req)[:\s]+.+?(?=(?:Equivalency|Fulfillment|Note:|$))/i, "")
    .replace(/Equivalency[:\s]+.+?(?=(?:Fulfillment|Note:|$))/i, "")
    .replace(/Fulfillment[:\s]+.+?(?=(?:Note:|$))/i, "")
    .replace(/Note[:\s]+.+$/i, "")
    .trim();

  // Extract prerequisite course IDs
  const prereqIds = [];
  if (prereqMatch) {
    const fullPrereqText = prereqMatch[0];
    const courseIdMatches = fullPrereqText.match(/[A-Z]{2,5}-[A-Z]{2,4}\s+\d+[A-Z]?/g);
    if (courseIdMatches) {
      for (const m of courseIdMatches) {
        prereqIds.push(m.replace(/\s+/g, "-"));
      }
    }
  }

  // Extract course attributes (SB Crse Attr)
  const attributes = [];
  const attrRegex = /<li>(.*?)<\/li>/gi;
  let attrMatch;
  while ((attrMatch = attrRegex.exec(block)) !== null) {
    attributes.push(cleanText(attrMatch[1]));
  }

  return {
    code: code.trim(),
    id: code.trim().replace(/\s+/g, "-"),
    name: name.trim(),
    credits,
    description,
    prerequisiteNote,
    prerequisiteIds: prereqIds,
    fulfillment,
    typicallyOffered,
    attributes,
  };
}

// Step 5: Scrape a program (major/minor) page

async function scrapeProgram(programPath) {
  const url = `${BASE_URL}${programPath}`;
  const html = await fetchPage(url);

  // Extract the main content
  const contentMatch = html.match(
    /class="page_content"[^>]*>([\s\S]*?)(?:<\/div>\s*<\/div>\s*<footer|<footer)/i,
  );
  const content = contentMatch ? contentMatch[1] : html;

  // Extract all course references
  const courseRefs = [];
  const coursePattern = /([A-Z]{2,5}-[A-Z]{2,4}\s+\d+[A-Z]?)/g;
  let match;
  while ((match = coursePattern.exec(content)) !== null) {
    courseRefs.push(match[1].replace(/\s+/g, "-"));
  }

  // Extract credit requirements
  const creditMatches = content.match(/(\d+)\s*credits?\s*(?:required|total)/gi);
  const totalCredits = creditMatches
    ? parseInt(creditMatches[0].match(/\d+/)[0], 10)
    : null;

  // Get the full text content for manual review
  const textContent = cleanText(content);

  return {
    rawText: textContent.slice(0, 5000), // First 5000 chars for context
    courseReferences: [...new Set(courseRefs)],
    totalCredits,
  };
}

//  *Main*

async function main() {
  const args = process.argv.slice(2);
  const flags = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] && !args[i + 1].startsWith("--")
        ? args[i + 1]
        : true;
      if (flags[key] !== true) i++;
    }
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });

  // List schools
  if (flags["list-schools"]) {
    console.log("Fetching schools...\n");
    const schools = await getSchools();
    for (const s of schools) {
      console.log(`  ${s.slug.padEnd(30)} ${s.name}`);
    }
    console.log(`\n${schools.length} schools found.`);
    return;
  }

  // Determine which schools to scrape
  let schoolSlugs;
  if (flags.school) {
    schoolSlugs = [flags.school];
  } else {
    console.log("Fetching all schools...");
    const schools = await getSchools();
    schoolSlugs = schools.map((s) => s.slug);
    console.log(`Found ${schools.length} schools.\n`);
  }

  const allData = {};

  for (const schoolSlug of schoolSlugs) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`School: ${schoolSlug}`);
    console.log("=".repeat(60));

    // Get subjects
    console.log("  Fetching subjects...");
    await sleep(DELAY_MS);
    let subjects = await getSubjects(schoolSlug);

    if (flags.subject) {
      subjects = subjects.filter((s) => s.slug === flags.subject);
      if (subjects.length === 0) {
        console.log(`  Subject "${flags.subject}" not found.`);
        continue;
      }
    }

    console.log(`  Found ${subjects.length} subjects.`);

    const schoolCourses = {};

    for (const subject of subjects) {
      console.log(`  Scraping ${subject.code} (${subject.name})...`);
      await sleep(DELAY_MS);

      try {
        const courses = await scrapeCourses(subject.path);
        if (courses.length > 0) {
          schoolCourses[subject.slug] = {
            code: subject.code,
            name: subject.name,
            courses,
          };
          console.log(`    → ${courses.length} courses`);
        } else {
          console.log(`    → 0 courses (page may use different format)`);
        }
      } catch (err) {
        console.error(`    ✗ Error: ${err.message}`);
      }
    }

    // Get programs (majors/minors)
    if (!flags.subject) {
      console.log("  Fetching programs...");
      await sleep(DELAY_MS);
      const programs = await getPrograms(schoolSlug);
      console.log(`  Found ${programs.length} programs.`);

      const schoolPrograms = {};
      for (const program of programs) {
        console.log(`  Scraping program: ${program.name}...`);
        await sleep(DELAY_MS);
        try {
          const data = await scrapeProgram(program.path);
          schoolPrograms[program.slug] = {
            name: program.name,
            ...data,
          };
        } catch (err) {
          console.error(`    ✗ Error: ${err.message}`);
        }
      }

      allData[schoolSlug] = {
        courses: schoolCourses,
        programs: schoolPrograms,
      };
    } else {
      allData[schoolSlug] = { courses: schoolCourses };
    }

    // Save per-school file
    const schoolFile = join(OUTPUT_DIR, `${schoolSlug}.json`);
    writeFileSync(schoolFile, JSON.stringify(allData[schoolSlug], null, 2));
    console.log(`  Saved → ${schoolFile}`);
  }

  // Save combined file
  const combinedFile = join(OUTPUT_DIR, "all-courses.json");
  writeFileSync(combinedFile, JSON.stringify(allData, null, 2));
  console.log(`\nAll data saved → ${combinedFile}`);

  // Print summary
  let totalCourses = 0;
  let totalPrograms = 0;
  for (const school of Object.values(allData)) {
    for (const subject of Object.values(school.courses || {})) {
      totalCourses += subject.courses.length;
    }
    totalPrograms += Object.keys(school.programs || {}).length;
  }
  console.log(
    `\nTotal: ${totalCourses} courses, ${totalPrograms} programs across ${schoolSlugs.length} school(s).`,
  );
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
