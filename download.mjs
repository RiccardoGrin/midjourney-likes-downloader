#!/usr/bin/env node

/**
 * Midjourney Likes Downloader
 *
 * Downloads all liked images from midjourney.com with their prompts.
 * Launches your real Chrome (not Playwright's Chromium) with a persistent
 * session — log in once and it remembers you.
 *
 * Usage:
 *   1. Close all Chrome windows first
 *   2. node download.mjs
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import readline from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "downloads");
const BROWSER_DATA = path.join(__dirname, ".browser-data");
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json");

// ── Helpers ──────────────────────────────────────────────────────────────────

function ask(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) =>
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadManifest() {
  if (fs.existsSync(MANIFEST_PATH)) {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  }
  return {};
}

function saveManifest(manifest) {
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const manifest = loadManifest();
  const existingCount = Object.keys(manifest).length;
  if (existingCount > 0) {
    console.log(
      `Resuming — manifest has ${existingCount} entries (will skip these).`
    );
  }

  console.log("\nLaunching Chrome (close all Chrome windows first!)...\n");

  // Launch real Chrome binary with a clean persistent profile.
  // Uses your installed Chrome (not Playwright's Chromium) to avoid Cloudflare.
  // You log in once — session is saved in .browser-data/ for future runs.
  const context = await chromium.launchPersistentContext(BROWSER_DATA, {
    channel: "chrome",
    headless: false,
    viewport: { width: 1400, height: 900 },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  // Open a new tab for our work — don't interfere with restored tabs
  const page = await context.newPage();
  await page.goto("https://www.midjourney.com", {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  console.log(`
╔═══════════════════════════════════════════╗
║   Midjourney Likes Downloader             ║
╠═══════════════════════════════════════════╣
║  1. Log in to Midjourney in the browser   ║
║  2. Navigate to your Likes page           ║
║  3. Come back here and press ENTER        ║
╚═══════════════════════════════════════════╝`);

  await ask("\nPress ENTER when you are on your Likes page... ");

  // Re-grab the active page (user may have navigated in a different tab)
  const allPages = context.pages();
  const mjPage =
    allPages.find((p) => p.url().includes("midjourney.com")) || page;

  // ── Phase 1: Collect images while user scrolls ─────────────────────────────

  // Inject a collector that captures job IDs as they appear/disappear
  // (the page uses virtual scrolling — only ~36 are in the DOM at once)
  await mjPage.evaluate(() => {
    window.__mjCollected = new Map();

    function collect() {
      // From <a> links
      document.querySelectorAll('a[href*="/jobs/"]').forEach((a) => {
        try {
          const url = new URL(a.href);
          const m = url.pathname.match(/\/jobs\/([a-f0-9-]{36})/);
          if (m) {
            const id = m[1];
            const index = url.searchParams.get("index") || "0";
            const key = `${id}_${index}`;
            if (!window.__mjCollected.has(key)) {
              window.__mjCollected.set(key, { id, index, key });
            }
          }
        } catch {}
      });
      // From CDN images
      document
        .querySelectorAll('img[src*="cdn.midjourney.com"]')
        .forEach((img) => {
          const m = img.src.match(/cdn\.midjourney\.com\/([a-f0-9-]{36})/);
          if (m) {
            const id = m[1];
            const key = `${id}_0`;
            if (!window.__mjCollected.has(key)) {
              window.__mjCollected.set(key, { id, index: "0", key });
            }
          }
        });
    }

    // Watch for DOM changes + poll every 500ms
    new MutationObserver(collect).observe(document.body, {
      childList: true,
      subtree: true,
    });
    setInterval(collect, 500);
    collect();
  });

  // Show live count while user scrolls
  console.log("\nCollecting images — scroll through your Likes now.");
  console.log("The counter below updates as new images are detected.\n");

  let lastCount = 0;
  const countInterval = setInterval(async () => {
    try {
      const count = await mjPage.evaluate(
        () => window.__mjCollected?.size || 0
      );
      if (count !== lastCount) {
        process.stdout.write(`\r  Images found: ${count}`);
        lastCount = count;
      }
    } catch {}
  }, 1000);

  await ask("\n\nPress ENTER when you've scrolled through everything... ");
  clearInterval(countInterval);

  const jobs = await mjPage.evaluate(() => [
    ...window.__mjCollected.values(),
  ]);

  console.log(`\nFound ${jobs.length} liked images total.`);

  if (jobs.length === 0) {
    console.log("\nNo images found. The page structure may have changed.");
    console.log("Dumping page info for debugging...");
    const debug = await mjPage.evaluate(() => ({
      url: location.href,
      linkCount: document.querySelectorAll("a").length,
      imgCount: document.querySelectorAll("img").length,
      sampleLinks: [...document.querySelectorAll("a")]
        .slice(0, 10)
        .map((a) => a.href),
      sampleImgs: [...document.querySelectorAll("img")]
        .slice(0, 10)
        .map((i) => i.src),
    }));
    console.log(JSON.stringify(debug, null, 2));
    await context.close();
    return;
  }

  const toDownload = jobs.filter((j) => !manifest[j.key]);
  console.log(
    `${toDownload.length} new to download, ${jobs.length - toDownload.length} already done.\n`
  );

  if (toDownload.length === 0) {
    console.log("Nothing new to download!");
    await context.close();
    return;
  }

  // ── Phase 2: Download each image + prompt ─────────────────────────────────

  console.log("[Phase 2] Downloading images and prompts...\n");

  let downloaded = 0;
  let errors = 0;

  for (let i = 0; i < toDownload.length; i++) {
    const job = toDownload[i];
    const tag = `[${i + 1}/${toDownload.length}]`;

    try {
      await mjPage.goto(
        `https://www.midjourney.com/jobs/${job.id}?index=${job.index}`,
        { waitUntil: "domcontentloaded", timeout: 30000 }
      );

      // Wait for the image to appear
      try {
        await mjPage.waitForSelector('img[src*="cdn.midjourney.com"]', {
          timeout: 15000,
        });
      } catch {
        await sleep(3000);
      }

      await sleep(1500); // Let prompt text render

      // Extract prompt
      const promptText = await mjPage.evaluate(() => {
        const p = document.querySelector("div.notranslate p");
        if (p?.textContent?.trim()) return p.textContent.trim();
        const p2 = document.querySelector('[class*="promptText"] p');
        if (p2?.textContent?.trim()) return p2.textContent.trim();
        return "";
      });

      // Extract the actual full-res image URL from the page
      // (prefer jpeg > png > webp since webp thumbnails are low quality)
      let imageUrl = await mjPage.evaluate(() => {
        const imgs = [
          ...document.querySelectorAll('img[src*="cdn.midjourney.com"]'),
        ];
        const jpeg = imgs.find((i) => /\.jpe?g/.test(i.src));
        if (jpeg) return jpeg.src;
        const png = imgs.find((i) => /\.png/.test(i.src));
        if (png) return png.src;
        return imgs[0]?.src || null;
      });

      if (!imageUrl) {
        console.log(`${tag} SKIP ${job.key} — no image found on page`);
        errors++;
        continue;
      }

      const ext = imageUrl.match(/\.(jpeg|jpg|png|webp)/)?.[0] || ".jpeg";
      const filename = `${job.key}${ext}`;
      const imagePath = path.join(OUTPUT_DIR, filename);

      const base64 = await mjPage.evaluate(async (url) => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      }, imageUrl);

      fs.writeFileSync(imagePath, Buffer.from(base64, "base64"));

      // Save prompt alongside
      if (promptText) {
        fs.writeFileSync(
          path.join(OUTPUT_DIR, `${job.key}.txt`),
          promptText,
          "utf8"
        );
      }

      // Update manifest (saved after each image for resume support)
      manifest[job.key] = {
        jobId: job.id,
        index: job.index,
        prompt: promptText,
        imageUrl,
        filename,
        downloadedAt: new Date().toISOString(),
      };
      saveManifest(manifest);

      const preview = promptText
        ? promptText.slice(0, 55) + (promptText.length > 55 ? "..." : "")
        : "(no prompt found)";
      console.log(`${tag} OK  ${job.key} — "${preview}"`);
      downloaded++;

      await sleep(1500);
    } catch (err) {
      console.log(`${tag} ERR ${job.key} — ${err.message}`);
      errors++;
      await sleep(2000);
    }
  }

  // ── Done ───────────────────────────────────────────────────────────────────

  console.log("\n════════════════════════════════════");
  console.log(`  Downloaded: ${downloaded}`);
  console.log(`  Errors:     ${errors}`);
  console.log(`  Output:     ${OUTPUT_DIR}`);
  console.log("════════════════════════════════════");

  await context.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
