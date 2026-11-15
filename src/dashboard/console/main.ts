import './console.css';

/**
 * The console's entry (#1): the page at shipyard.outright.io.
 *
 * This is the frame the console is built into (#3). For now it says the one
 * thing there is to say — that the platform is up, and which commit it runs —
 * read from /healthz on its own origin.
 */
async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;
  const line = document.createElement('div');
  line.className = 'console-starting';
  line.textContent = 'Shipyard';
  root.replaceChildren(line);
  try {
    const res = await fetch('/healthz', { cache: 'no-store' });
    const body = await res.json() as { release?: string | null };
    line.textContent = body.release ? `Shipyard · ${body.release.slice(0, 7)}` : 'Shipyard';
  } catch {
    line.textContent = 'Shipyard · the platform could not be reached';
  }
}

void boot();
