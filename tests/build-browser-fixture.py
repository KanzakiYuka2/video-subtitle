"""Generate an isolated browser fixture. Open its printed path in Chrome."""
from pathlib import Path
root = Path(__file__).resolve().parents[1]
content = (root / 'extension/content.js').read_text()
content = content[:content.rindex("  if (document.readyState === 'loading')")] + '''
window.testAPI = { state, ensureUI, setCues, renderCurrentSubtitle, toggleLyrics, detectWorkInfo };
})();'''
player = (root / 'extension/player.js').read_text()
# Force the Prime site branch while running from a local file.
player = player.replace('const isPrime = /(^|\\.)(primevideo\\.com|amazon\\.co\\.jp)$/.test(location.hostname);', 'const isPrime = true;')
scripts = ["window.chrome = {runtime:{onMessage:{addListener(){}}},storage:{local:{set(){}}}};",
           player, (root / 'extension/background.js').read_text(), content,
           (root / 'tests/prime-browser.js').read_text()]
html = '<!doctype html><meta charset="utf-8"><body><video style="display:none"></video><video id="main-video" style="width:800px;height:450px"></video><div class="atvwebplayersdk-title-text">Test Drama</div><div class="atvwebplayersdk-subtitle-text"></div><pre id="result">RUNNING</pre>'
html += ''.join('<script>' + script + '</script>' for script in scripts)
out = Path('/tmp/prime-subtitle-test.html')
out.write_text(html)
print(out)
