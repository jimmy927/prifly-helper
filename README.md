# prifly Helper

The Chrome/Edge extension (Manifest V3) that lets prifly's plugins use your own signed-in browser:
fetch with your cookies, find or open a tab, run a plugin's code in a tab of a site it declared,
and take a screenshot. It knows no site itself; the plugins send their requests and code as data,
and prifly queues and paces them. It talks only to prifly on this machine
(`ws://127.0.0.1:4201/helper`), once paired.

## Set up

prifly builds this folder for you and shows these steps in **Settings → Browser Helper**, ticking
each one off as it sees it done:

1. **Load the Helper into Chrome or Edge.** Open chrome://extensions (edge://extensions in Edge),
   turn on Developer mode, click Load unpacked and pick this folder. Developer mode has to stay
   on. Chrome is recommended: Edge shows a notice about developer-mode extensions at every start
   that cannot be turned off.
2. **Allow user scripts.** On the Helper's Details page turn on Allow User Scripts. Without it
   the Helper can still fetch, but cannot run an extension's code in a tab.
3. **Pair this browser.** Click the Helper's icon in the toolbar and type this code. It works
   once and runs out in five minutes.

The popup then shows whether the Helper is connected, paired but waiting for prifly to start, or
missing Allow User Scripts.

## Extension id

`dmkobenilcamkhdpaccnpdpmonajocmh` — fixed by the `key` in `static/manifest.json`, the same on
every machine and in both Chrome and Edge. prifly accepts the `/helper` connection only from this
id. `bun test` checks that the key still gives it.

## Build

```sh
bun install --frozen-lockfile
bun run build      # writes dist/, the folder to load unpacked
bun test           # protocol tests against a fake socket and fake chrome.*
bun run typecheck
```

The icons live in `static/icons` (copied unchanged from prifly's desktop-shell assets).

`dist/` is not committed; prifly's installer clones this repo, runs the two commands above and
copies `dist/`.

The private key for the pinned id is outside the repo at `~/.config/prifly-helper/helper-key.pem`; it is needed only to pack a `.crx`, never for loading unpacked.
