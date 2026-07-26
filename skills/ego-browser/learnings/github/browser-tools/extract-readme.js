async function(args) {
  const readme = document.querySelector('article.markdown-body');
  if (!readme) return { error: 'no README rendered on this page' };
  const maxChars = Number.isFinite(Number(args.maxChars)) && Number(args.maxChars) > 0
    ? Math.trunc(Number(args.maxChars))
    : 4000;
  const headings = [...readme.querySelectorAll('h1, h2, h3')]
    .map((el) => el.innerText?.trim() || '')
    .filter(Boolean);
  return { headings, text: (readme.innerText || '').trim().slice(0, maxChars) };
}
