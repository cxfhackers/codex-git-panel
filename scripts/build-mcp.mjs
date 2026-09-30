import { readFile, mkdir, writeFile } from 'node:fs/promises';
const base = new URL('../', import.meta.url);
let html = await readFile(new URL('dist/index.html', base), 'utf8');
for (const match of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]) {
  const code = await readFile(new URL(`dist/${match[1].replace(/^\//, '')}`, base), 'utf8');
  html = html.replace(match[0], () => `<script type="module">${code.replaceAll('</script', '<\\/script')}</script>`);
}
for (const match of [...html.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*>/g)]) {
  const path = match[0].match(/href="([^"]+)"/)[1];
  const css = await readFile(new URL(`dist/${path.replace(/^\//, '')}`, base), 'utf8');
  html = html.replace(match[0], () => `<style>${css.replaceAll('</style', '<\\/style')}</style>`);
}
html = html.replace('<head>', '<head><script>window.__GIT_PANEL_MCP__=true;</script>');
await mkdir(new URL('dist-mcp/', base), { recursive: true });
await writeFile(new URL('dist-mcp/index.html', base), html);
console.log(`MCP 界面已打包（${Buffer.byteLength(html)} bytes），不依赖外部网页资源。`);
