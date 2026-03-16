# Midjourney Likes Downloader

Download all your liked images from [midjourney.com](https://www.midjourney.com) along with their prompts. Currently supports images only — videos are not supported.

## How it works

1. Opens your installed Chrome (not a bot browser) with a persistent session
2. You log in to Midjourney and navigate to your Likes page
3. You scroll through your likes while the script collects image IDs in the background
4. The script visits each image page, extracts the prompt, and downloads the full-res image

## Output

```
downloads/
  {jobId}_{index}.jpeg   # Full-resolution image
  {jobId}_{index}.txt    # Prompt text
  manifest.json          # All metadata (prompts, URLs, timestamps)
```

## Setup

Requires [Node.js](https://nodejs.org/) (v18+) and [Google Chrome](https://www.google.com/chrome/).

```bash
git clone https://github.com/RiccardoGrin/midjourney-likes-downloader.git
cd midjourney-likes-downloader
npm install
```

## Usage

Close all Chrome windows first, then:

```bash
node download.mjs
```

The script will:

1. Launch Chrome — log in to Midjourney if this is your first run (session is saved for next time)
2. Navigate to your Likes page, then press **ENTER** in the terminal
3. Scroll through all your likes — a live counter shows images detected
4. Press **ENTER** when you've reached the bottom
5. The script downloads everything automatically

### Resuming

Re-running the script skips already-downloaded images. If it was interrupted or had errors, just run it again.

## Why Chrome instead of a headless browser?

Midjourney uses Cloudflare bot detection. By launching your real Chrome binary (`channel: "chrome"`) with automation flags disabled, the script avoids being blocked. The trade-off is you need to close Chrome before running.

## Notes

- The page uses virtual scrolling — only ~36 images exist in the DOM at once. The script injects a background collector that captures IDs as you scroll.
- Images are downloaded from within the browser context to avoid CDN 403 errors.
- First run creates a `.browser-data/` directory for the persistent session. This is gitignored.
