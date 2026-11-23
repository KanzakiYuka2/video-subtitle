"""Generate an isolated browser fixture. Open its printed path in Chrome."""
from pathlib import Path
import argparse
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--search", action="store_true", help="Build the offline search regression fixture")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
content = (root / 'extension/content.js').read_text(encoding='utf-8')
content = content[:content.rindex("  if (document.readyState === 'loading')")] + '''
window.testAPI = { state, ensureUI, setCues, renderCurrentSubtitle, toggleLyrics, detectWorkInfo };
})();'''

registry = (root / 'extension/players/registry.js').read_text(encoding='utf-8')
danime_adapter = (root / 'extension/players/danime.js').read_text(encoding='utf-8')
prime_adapter = (root / 'extension/players/prime.js').read_text(encoding='utf-8')
# Force the Prime adapter branch while running from a local file.
prime_adapter = prime_adapter.replace(
    'return /(^|\\.)(primevideo\\.com|amazon\\.co\\.jp)$/.test(loc.hostname);',
    'return true;',
)

styles = (root / 'extension/styles.css').read_text()
i18n_path = root / 'extension/i18n.js'
i18n_script = i18n_path.read_text(encoding='utf-8') if i18n_path.exists() else ''
source_profiles_path = root / 'extension/source_profiles.js'
source_profiles_script = source_profiles_path.read_text(encoding='utf-8') if source_profiles_path.exists() else ''

scripts = [
    "window.chrome = {runtime:{onMessage:{addListener(){}}},storage:{local:{set(){}}}};",
    i18n_script,
    source_profiles_script,
    registry,
    danime_adapter,
    prime_adapter,
    (root / 'extension/background.js').read_text(encoding='utf-8'),
    content,
    (root / 'tests/prime-browser.js').read_text(encoding='utf-8'),
]
host_styles = '''
input, select {
  color: transparent !important;
  -webkit-text-fill-color: transparent !important;
  opacity: 0.01 !important;
  text-shadow: 0 0 transparent !important;
}
'''
html = '<!doctype html><meta charset="utf-8"><style>' + host_styles + styles + '</style><body><video style="display:none"></video><video id="main-video" style="width:800px;height:450px"></video><div class="atvwebplayersdk-title-text">Test Drama</div><div class="atvwebplayersdk-subtitle-text"></div><pre id="result">RUNNING</pre>'
html += ''.join('<script>' + script + '</script>' for script in scripts if script)
if args.search:
    scripts = [
        "window.chrome = {runtime:{onMessage:{addListener(){}}}};",
        (root / 'extension/background.js').read_text(encoding='utf-8'),
        (root / 'tests/search-browser.js').read_text(encoding='utf-8'),
    ]
    html = '<!doctype html><meta charset="utf-8"><pre id="result">RUNNING</pre>'
    html += ''.join('<script>' + script + '</script>' for script in scripts)
out = Path(tempfile.gettempdir()) / ('subtitle-search-test.html' if args.search else 'prime-subtitle-test.html')
out.write_text(html, encoding='utf-8')
print(out)
