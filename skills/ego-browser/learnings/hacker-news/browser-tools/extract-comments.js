async function(args) {
  const rows = [...document.querySelectorAll('tr.athing.comtr')];
  if (!rows.length) return { error: 'no comments found on this page' };
  const maxComments = Number.isFinite(Number(args.maxComments)) && Number(args.maxComments) > 0
    ? Math.trunc(Number(args.maxComments))
    : 30;
  return rows.slice(0, maxComments).map((row) => ({
    id: row.id || '',
    author: row.querySelector('a.hnuser')?.innerText?.trim() || '',
    indent: Number(row.querySelector('td.ind')?.getAttribute('indent') || 0),
    text: row.querySelector('.commtext')?.innerText?.trim() || '',
  }));
}
