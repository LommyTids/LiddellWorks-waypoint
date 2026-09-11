// Source-based regression tests follow the same local assets as the browser.
// `html` and `scripts` describe the real document. `source` combines application
// scripts in document order inside one virtual script, so older function-slicing
// assertions can span file boundaries without slicing through HTML tags.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

function loadAppSources({ gitRef } = {}) {
  const read = (file) => gitRef
    ? execFileSync('git', ['show', gitRef + ':' + file], { cwd: __dirname, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    : fs.readFileSync(path.join(__dirname, file), 'utf8');
  const html = read('public/WayPoint/index.html');
  const scripts = [];
  const appScripts = [];
  const styles = [];
  const attribute = (tag, name) => {
    const match = tag.match(new RegExp('\\b' + name + '\\s*=\\s*(["\x27])([^]*?)\\1', 'i'));
    return match ? match[2] : '';
  };
  const localFile = (url) => {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return null;
    const resolved = new URL(url, 'https://waypoint.test/WayPoint/');
    if (!resolved.pathname.startsWith('/WayPoint/')) throw new Error('App asset escapes /WayPoint/: ' + url);
    return 'public' + decodeURIComponent(resolved.pathname);
  };

  let source = html.replace(/<script\b([^>]*?)>([^]*?)<\/script>/gi, (tag, attributes, inline) => {
    const src = attribute(attributes, 'src');
    const file = src ? localFile(src) : null;
    if (src && !file) return tag;
    const code = file ? read(file) : inline;
    const filename = file || 'public/WayPoint/index.html:inline-' + (scripts.length + 1);
    // Parse every local script, including dependencies: extracting JS must not
    // turn the old inline-script syntax check into a successful empty loop.
    new vm.Script(code, { filename });
    const script = { filename, src, code, attributes };
    scripts.push(script);
    // Data, icons and vendored scripts retain their existing dedicated tests;
    // only application scripts belong in the old inline-app source contract.
    if (file && file.startsWith('public/WayPoint/js/')) {
      if (!code.trim()) throw new Error('Application script is empty: ' + file);
      appScripts.push(script);
      return appScripts.length === 1 ? '<!-- APP_SOURCE_PLACEHOLDER -->' : '';
    }
    return tag;
  });
  if (!scripts.length) throw new Error('No local or inline scripts found in the app document');
  // Historical git baselines still contain their application inline.
  if (!appScripts.length && !scripts.some(script => !script.src && script.code.trim())) {
    throw new Error('No application scripts found in the app document');
  }
  if (appScripts.length) {
    source = source.replace('<!-- APP_SOURCE_PLACEHOLDER -->', () =>
      '<script>\n' + appScripts.map(script => script.code).join('\n') + '\n</script>');
  }
  source = source.replace(/<link\b[^>]*>|<style\b[^>]*>([^]*?)<\/style>/gi, (tag, inline) => {
    if (inline !== undefined) {
      styles.push(inline);
      return tag;
    }
    if (attribute(tag, 'rel').toLowerCase() !== 'stylesheet') return tag;
    const file = localFile(attribute(tag, 'href'));
    if (!file) return tag;
    const css = read(file); // Missing local styles fail even for vendor assets.
    if (!file.startsWith('public/WayPoint/styles/')) return tag;
    styles.push(css);
    return tag + '\n<style>' + css + '</style>';
  });
  return { html, source, style: styles.join('\n'), scripts, appScripts };
}

module.exports = { loadAppSources };
