# Flip Spider

A tiny HTML5 canvas web game inspired by Flappy Bird, but you play as a web‑slinger who vaults upward by throwing webs instead of flapping.

## Play

- Open `index.html` in your browser (double‑click is fine).
- Controls: click / tap / press Space to throw a web and get a quick upward boost.
- Pass through building gaps to score. If you hit a building or the ground/ceiling, it's game over.

## Dev notes

No build step or dependencies. Everything is plain HTML/CSS/JS.

If you prefer a local server (optional), from the repo root:

```powershell
# Using Node's http-server (installs once globally):
npm i -g http-server
http-server -c-1 -p 5173 .

# Or npx (no global install):
npx http-server -c-1 -p 5173 .
```

Then open `http://localhost:5173/flipSpider/`.




